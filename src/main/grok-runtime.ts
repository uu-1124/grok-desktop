import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";

import {
  PROTOCOL_VERSION,
  client,
  methods,
  ndJsonStream,
  type ClientConnection,
  type ClientContext,
  type ContentBlock,
  type InitializeResponse,
  type LoadSessionResponse,
  type McpServer,
  type NewSessionResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
} from "@agentclientprotocol/sdk";

import type {
  AuthMethodInfo,
  AvailableCommand,
  ConnectRequest,
  DesktopEvent,
  McpServerConfig,
  ModelInfo,
  PermissionRequestPayload,
  PermissionResponsePayload,
  PermissionModePreference,
  PromptRequest,
  RuntimeCapabilities,
  RuntimeSnapshot,
  SessionConfigOption,
  SessionExecutionSnapshot,
  SessionModeOption,
  SessionReadyPayload,
  TurnOutcome,
} from "../shared/contracts.js";
import {
  assertMcpTransportsAdvertised,
  collectMcpSensitiveValues,
  isolateMcpStdioEnvironment,
  normalizeMcpServers,
} from "../shared/mcp-config.js";
import {
  createEmptyRuntimeCapabilities,
  isPermissionOptionKind,
  MAX_PROMPT_CONTEXT_FILES,
} from "../shared/contracts.js";
import {
  normalizeRequiredXaiConnection,
} from "../shared/xai-connection.js";
import {
  buildGrokAgentLaunch,
  containsSensitiveText,
  redactSensitiveText,
  redactSerializableSecrets,
} from "./grok-launch.js";
import {
  parseAgentCapabilities,
  parseAvailableCommands,
  parseReportedMcpServerCount,
  parseSessionCapabilities,
} from "./acp-capabilities.js";
import type {
  PreparedPromptContextFile,
  PreparedPromptImage,
} from "./workspace-files.js";

const CLIENT_NAME = "Grok Desktop";
const CLIENT_VERSION = "0.1.4";
const CONNECT_TIMEOUT_MS = 20_000;
const SPAWN_TIMEOUT_MS = 5_000;
const GRACEFUL_EXIT_TIMEOUT_MS = 1_500;
const FORCED_EXIT_TIMEOUT_MS = 500;
const DEFAULT_PERMISSION_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_CANCEL_CONFIRM_TIMEOUT_MS = 15_000;
const MAX_STDERR_TAIL_LENGTH = 8_192;
const MAX_PATH_LENGTH = 32_767;
const GROK_MCP_SERVERS_UPDATED_NOTIFICATION = "_x.ai/mcp/servers_updated";
const MAX_IDENTIFIER_LENGTH = 1_024;
const MAX_TITLE_LENGTH = 200;
const MAX_PROMPT_LENGTH = 1_000_000;

interface NormalizedConnectRequest {
  workspacePath: string;
  executablePath: string;
  modelId: string | null;
  reasoningEffort: string | null;
  permissionMode: PermissionModePreference;
  xaiApiBaseUrl: string;
  xaiApiKey: string;
  mcpServers: McpServerConfig[];
}

interface SessionState {
  sessionId: string;
  title: string;
  currentModeId: string | null;
  availableModes: SessionModeOption[];
  configOptions: SessionConfigOption[];
  availableCommands: AvailableCommand[];
  loaded: boolean;
}

interface PendingPermission {
  sessionId: string;
  optionIds: Set<string>;
  payload: PermissionRequestPayload;
  timeout: NodeJS.Timeout;
  resolve: (response: RequestPermissionResponse) => void;
  removeAbortListener: () => void;
}

interface ActiveCancellation {
  turnId: string;
  promise: Promise<void>;
}

export interface GrokRuntimeOptions {
  permissionTimeoutMs?: number;
  cancelTimeoutMs?: number;
  connectTimeoutMs?: number;
  now?: () => Date;
  createId?: () => string;
}

/**
 * Owns one persistent ACP connection to a local Grok agent process.
 *
 * The executable remains external to the desktop app. This class only launches
 * `grok agent ... stdio` and never reads Grok's configuration or session files.
 */
export class GrokRuntime {
  private readonly emit: (event: DesktopEvent) => void;
  private readonly permissionTimeoutMs: number;
  private readonly cancelTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly now: () => Date;
  private readonly createId: () => string;

  private snapshot: RuntimeSnapshot = createOfflineSnapshot();
  private child: ChildProcessWithoutNullStreams | null = null;
  private connection: ClientConnection | null = null;
  private agent: ClientContext | null = null;
  private stderrTail = "";
  private sensitiveValues: string[] = [];
  private xaiApiKey: string | null = null;
  private xaiApiKeyConfigured = false;
  private mcpServers: McpServerConfig[] = [];
  /** Names only; values from the Grok launch environment are never duplicated here. */
  private mcpInheritedEnvironment: Readonly<Record<string, string | undefined>> = {};
  private connectInProgress = false;
  private lifecycleGeneration = 0;

  private readonly expectedExits = new WeakSet<ChildProcessWithoutNullStreams>();
  private readonly sessions = new Map<string, SessionState>();
  private readonly activePrompts = new Set<string>();
  private readonly activeCancellations = new Map<string, ActiveCancellation>();
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly executions = new Map<string, SessionExecutionSnapshot>();
  private readonly loadingSessionUpdates = new Map<
    string,
    Array<Extract<DesktopEvent, { type: "session-update" }>>
  >();
  private readonly cancelWatchdogs = new Map<
    string,
    { turnId: string; timeout: NodeJS.Timeout }
  >();

  constructor(emit: (event: DesktopEvent) => void, options: GrokRuntimeOptions = {}) {
    if (typeof emit !== "function") {
      throw new TypeError("GrokRuntime requires an event callback.");
    }
    this.emit = emit;
    this.permissionTimeoutMs = requirePositiveTimeout(
      options.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS,
      "permissionTimeoutMs",
    );
    this.cancelTimeoutMs = requirePositiveTimeout(
      options.cancelTimeoutMs ?? DEFAULT_CANCEL_CONFIRM_TIMEOUT_MS,
      "cancelTimeoutMs",
    );
    this.connectTimeoutMs = requirePositiveTimeout(
      options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
      "connectTimeoutMs",
    );
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
  }

  getSnapshot(): RuntimeSnapshot {
    return redactSerializableSecrets({
      ...cloneSnapshot(this.snapshot),
      xaiApiKeyConfigured: this.xaiApiKeyConfigured,
      mcpConfigured: this.mcpServers.length > 0,
    }, this.sensitiveValues);
  }

  get active(): boolean {
    return Boolean(this.child || this.connection || this.agent);
  }

  get hasActiveWork(): boolean {
    return this.activePrompts.size > 0 ||
      this.activeCancellations.size > 0 ||
      this.pendingPermissions.size > 0;
  }

  getSessions(): SessionReadyPayload[] {
    const workspacePath = this.snapshot.workspacePath;
    if (!workspacePath) {
      return [];
    }
    return [...this.sessions.values()].map((session) =>
      redactSerializableSecrets(
        toSessionReadyPayload(session, workspacePath, session.loaded),
        this.sensitiveValues,
      ),
    );
  }

  getPendingPermissions(): PermissionRequestPayload[] {
    return [...this.pendingPermissions.values()].map((pending) =>
      redactSerializableSecrets(cloneSerializable(pending.payload), this.sensitiveValues),
    );
  }

  async connect(request: ConnectRequest): Promise<RuntimeSnapshot> {
    return this.connectInternal(request);
  }

  async connectWithAdvertisedModels(
    request: ConnectRequest,
    advertisedModels: readonly ModelInfo[],
  ): Promise<RuntimeSnapshot> {
    return this.connectInternal(request, advertisedModels);
  }

  private async connectInternal(
    request: ConnectRequest,
    advertisedModels?: readonly ModelInfo[],
  ): Promise<RuntimeSnapshot> {
    if (this.connectInProgress) {
      throw new Error("A Grok connection attempt is already in progress.");
    }

    this.connectInProgress = true;
    let normalized: NormalizedConnectRequest | null = null;
    let generation = this.lifecycleGeneration;
    const requestGeneration = this.lifecycleGeneration;

    try {
      normalized = await normalizeConnectRequest(request);
      if (requestGeneration !== this.lifecycleGeneration) {
        throw new Error("The Grok connection attempt was cancelled.");
      }
      const selectionSnapshot = advertisedModels
        ? {
            ...this.snapshot,
            executablePath: normalized.executablePath,
            availableModels: advertisedModels.map(cloneModelInfo),
          }
        : this.snapshot;
      assertAdvertisedModelSelection(
        normalized.modelId,
        normalized.executablePath,
        selectionSnapshot,
      );
      assertAdvertisedReasoningEffort(
        normalized.reasoningEffort,
        normalized.modelId,
        normalized.executablePath,
        selectionSnapshot,
      );

      if (this.hasActiveWork) {
        throw new Error("Cannot reconnect while a Grok turn or permission request is active.");
      }
      if (this.child || this.connection || this.agent) {
        await this.disconnect();
      }

      generation = ++this.lifecycleGeneration;
      this.stderrTail = "";
      this.xaiApiKeyConfigured = normalized.xaiApiKey !== undefined;
      this.xaiApiKey = normalized.xaiApiKey;
      this.sensitiveValues = collectSensitiveValues(
        normalized.xaiApiKey,
        process.env.XAI_API_KEY,
        process.env.GROK_CODE_XAI_API_KEY,
        ...collectMcpSensitiveValues(normalized.mcpServers),
      );
      this.sessions.clear();
      this.clearAllCancelWatchdogs();
      this.activePrompts.clear();
      this.activeCancellations.clear();
      this.cancelAllPermissions();
      this.executions.clear();
      this.loadingSessionUpdates.clear();
      this.updateSnapshot({
        phase: "connecting",
        permissionMode: normalized.permissionMode,
        xaiApiBaseUrl: normalized.xaiApiBaseUrl,
        workspacePath: normalized.workspacePath,
        executablePath: normalized.executablePath,
        grokVersion: null,
        protocolVersion: null,
        currentModelId: normalized.modelId,
        availableModels: [],
        authMethods: [],
        reportedMcpServerCount: 0,
        reportedMcpServerCountTruncated: false,
        capabilities: createEmptyRuntimeCapabilities(),
        sessionExecutions: [],
        message: "Starting the local Grok agent...",
      });

      const launch = buildGrokAgentLaunch(normalized);
      const child = spawn(normalized.executablePath, launch.args, {
        cwd: normalized.workspacePath,
        env: launch.env,
        windowsHide: true,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });

      this.child = child;
      this.captureStandardError(child);
      await waitForSpawn(child, SPAWN_TIMEOUT_MS);
      this.assertCurrentGeneration(generation);

      const app = client({ name: CLIENT_NAME })
        .onRequest(methods.client.session.requestPermission, (context) => {
          if (generation !== this.lifecycleGeneration || this.child !== child) {
            return { outcome: { outcome: "cancelled" } };
          }
          return this.handlePermissionRequest(context.params, context.signal);
        })
        .onNotification(
          GROK_MCP_SERVERS_UPDATED_NOTIFICATION,
          (params: unknown) => params,
          (context) => {
            if (generation === this.lifecycleGeneration && this.child === child) {
              this.handleReportedMcpServers(context.params);
            }
          },
        )
        .onNotification(methods.client.session.update, (context) => {
          if (generation === this.lifecycleGeneration && this.child === child) {
            this.handleSessionUpdate(context.params);
          }
        });

      const stream = ndJsonStream(
        Writable.toWeb(child.stdin),
        Readable.toWeb(child.stdout),
      );
      const connection = app.connect(stream);
      this.connection = connection;
      this.agent = connection.agent;
      this.observeProcess(child);
      this.observeConnection(child, connection);

      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(formatProcessExit(child.exitCode, child.signalCode));
      }

      const initialization = await withTimeout(
        connection.agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {
            session: {
              configOptions: {
                boolean: {},
              },
            },
            plan: {},
          },
          clientInfo: {
            name: CLIENT_NAME,
            title: CLIENT_NAME,
            version: CLIENT_VERSION,
          },
        }),
        this.connectTimeoutMs,
        "Timed out while initializing the Grok ACP connection.",
      );

      this.assertCurrentGeneration(generation);
      assertSupportedProtocol(initialization.protocolVersion);
      const initializationState = parseInitialization(initialization, normalized.modelId);
      assertModelMetadataDoesNotContainCredentials(
        initializationState,
        normalized.xaiApiKey,
      );
      assertMcpTransportsAdvertised(
        normalized.mcpServers,
        initializationState.capabilities.mcp,
      );
      const mcpInheritedEnvironment = mcpEnvironmentMaskFromLaunch(launch.env);
      // Validate against the exact environment given to Grok, including an
      // API key entered in the UI that does not exist in process.env.
      toAcpMcpServers(normalized.mcpServers, mcpInheritedEnvironment);
      this.mcpInheritedEnvironment = mcpInheritedEnvironment;
      this.mcpServers = cloneMcpServers(normalized.mcpServers);

      this.updateSnapshot({
        phase: "ready",
        permissionMode: normalized.permissionMode,
        workspacePath: normalized.workspacePath,
        executablePath: normalized.executablePath,
        grokVersion: initializationState.grokVersion,
        protocolVersion: initialization.protocolVersion,
        currentModelId: initializationState.currentModelId,
        availableModels: initializationState.availableModels,
        authMethods: initializationState.authMethods,
        capabilities: initializationState.capabilities,
        message: null,
      });
      return this.getSnapshot();
    } catch (error: unknown) {
      const converted = toRuntimeError(
        "Unable to connect to Grok",
        error,
        this.stderrTail,
        collectSensitiveValues(
          ...this.sensitiveValues,
          normalized?.xaiApiKey,
          ...collectMcpSensitiveValues(normalized?.mcpServers ?? []),
          process.env.XAI_API_KEY,
          process.env.GROK_CODE_XAI_API_KEY,
        ),
      );
      if (generation === this.lifecycleGeneration) {
        await this.teardownConnection();
        this.updateSnapshot({
          phase: "error",
          workspacePath: normalized?.workspacePath ?? null,
          executablePath: normalized?.executablePath ?? null,
          reportedMcpServerCount: 0,
          reportedMcpServerCountTruncated: false,
          message: converted.message,
        });
      }
      throw converted;
    } finally {
      this.connectInProgress = false;
    }
  }

  async disconnect(): Promise<void> {
    ++this.lifecycleGeneration;
    const hadConnection = Boolean(
      this.child || this.connection || this.agent || this.pendingPermissions.size > 0,
    );
    if (hadConnection) {
      this.updateSnapshot({ phase: "stopping", message: "Stopping Grok..." });
    }

    await this.teardownConnection();
    this.snapshot = createOfflineSnapshot();
    this.emitEvent({ type: "runtime", snapshot: this.getSnapshot() });
  }

  async createSession(title?: string): Promise<SessionReadyPayload> {
    const agent = this.requireAgent();
    const sensitiveValues = [...this.sensitiveValues];
    const workspacePath = this.requireWorkspacePath();
    const normalizedTitle = normalizeOptionalTitle(title) ?? "New Grok task";

    try {
      const mcpServers = await this.prepareMcpServersForSession();
      const response = await agent.request(methods.agent.session.new, {
        cwd: workspacePath,
        mcpServers,
      });
      this.applySessionCapabilities(response);
      const session = createSessionState(
        response.sessionId,
        titleFromResponse(response) ?? normalizedTitle,
        response,
        false,
      );
      this.sessions.set(session.sessionId, session);
      this.ensureExecution(session.sessionId);
      this.refreshOperationalPhase();

      const payload = redactSerializableSecrets(
        toSessionReadyPayload(session, workspacePath, false),
        sensitiveValues,
      );
      this.emitEvent({ type: "session-ready", payload });
      return cloneSessionReadyPayload(payload);
    } catch (error: unknown) {
      throw toRuntimeError("Unable to create a Grok session", error, "", sensitiveValues);
    }
  }

  async loadSession(sessionId: string, storedTitle?: string): Promise<SessionReadyPayload> {
    const normalizedSessionId = requireIdentifier(sessionId, "sessionId");
    const normalizedStoredTitle = normalizeOptionalTitle(storedTitle);
    const agent = this.requireAgent();
    const sensitiveValues = [...this.sensitiveValues];
    const workspacePath = this.requireWorkspacePath();
    if (!this.snapshot.capabilities.session.load) {
      throw new Error("This Grok agent does not advertise session loading support.");
    }

    const previous = this.sessions.get(normalizedSessionId);
    if (this.loadingSessionUpdates.has(normalizedSessionId)) {
      throw new Error(`Grok session is already being loaded: ${normalizedSessionId}`);
    }
    if (previous) {
      const payload = redactSerializableSecrets(
        toSessionReadyPayload(previous, workspacePath, previous.loaded),
        sensitiveValues,
      );
      return cloneSessionReadyPayload(payload);
    }

    const provisional: SessionState = {
      sessionId: normalizedSessionId,
      title: normalizedStoredTitle ?? "Restored Grok task",
      currentModeId: null,
      availableModes: [],
      configOptions: [],
      availableCommands: [],
      loaded: true,
    };
    this.sessions.set(normalizedSessionId, provisional);
    this.loadingSessionUpdates.set(normalizedSessionId, []);

    try {
      const mcpServers = await this.prepareMcpServersForSession();
      const response = await agent.request(methods.agent.session.load, {
        sessionId: normalizedSessionId,
        cwd: workspacePath,
        mcpServers,
      });
      this.applySessionCapabilities(response);
      const latest = this.sessions.get(normalizedSessionId) ?? provisional;
      const responseTitle = titleFromResponse(response);
      const session = mergeSessionState(
        latest,
        responseTitle ?? latest.title,
        response,
        true,
      );
      this.sessions.set(normalizedSessionId, session);
      this.ensureExecution(normalizedSessionId);
      this.refreshOperationalPhase();

      const payload = redactSerializableSecrets(
        toSessionReadyPayload(session, workspacePath, true),
        sensitiveValues,
      );
      const stagedUpdates = this.loadingSessionUpdates.get(normalizedSessionId) ?? [];
      this.loadingSessionUpdates.delete(normalizedSessionId);
      for (const event of stagedUpdates) this.emitEvent(event);
      this.emitEvent({ type: "session-ready", payload });
      return cloneSessionReadyPayload(payload);
    } catch (error: unknown) {
      this.loadingSessionUpdates.delete(normalizedSessionId);
      this.sessions.delete(normalizedSessionId);
      throw toRuntimeError("Unable to load the Grok session", error, "", sensitiveValues);
    }
  }

  async prompt(
    request: PromptRequest,
    preparedContextFiles: readonly PreparedPromptContextFile[] = [],
    preparedImages: readonly PreparedPromptImage[] = [],
  ): Promise<void> {
    const normalized = normalizePromptRequest(request, this.requireWorkspacePath());
    const agent = this.requireAgent();
    const generation = this.lifecycleGeneration;
    const sensitiveValues = [...this.sensitiveValues];
    this.requireSession(normalized.sessionId);
    if (this.activeCancellations.has(normalized.sessionId)) {
      throw new Error("This session's cancellation is still in progress.");
    }
    if (this.activePrompts.has(normalized.sessionId)) {
      throw new Error("This session already has a prompt in progress.");
    }

    const turnId = requireIdentifier(this.createId(), "turnId");
    const startedAt = this.timestamp();
    this.clearCancelWatchdog(normalized.sessionId);
    this.activePrompts.add(normalized.sessionId);
    this.executions.set(normalized.sessionId, {
      sessionId: normalized.sessionId,
      phase: "working",
      turnId,
      startedAt,
      finishedAt: null,
      stopReason: null,
      error: null,
      pendingPermissionCount: 0,
    });
    this.refreshOperationalPhase();
    this.emitEvent({
      type: "turn-started",
      sessionId: normalized.sessionId,
      turnId,
      receivedAt: startedAt,
    });

    try {
      const prompt: ContentBlock[] = [
        { type: "text", text: normalized.text },
        ...createPromptContextBlocks(
          normalized.contextPaths ?? [],
          preparedContextFiles,
          preparedImages,
          this.snapshot.capabilities.prompt.embeddedContext,
        ),
      ];
      const response = await agent.request(methods.agent.session.prompt, {
        sessionId: normalized.sessionId,
        prompt,
      });
      if (!this.isCurrentPrompt(normalized.sessionId, turnId, generation, agent)) {
        return;
      }
      if (response.usage) {
        this.emitSyntheticSessionUpdate(normalized.sessionId, {
          sessionUpdate: "usage_update",
          usage: cloneSerializable(response.usage),
        });
      }
      const outcome = outcomeFromStopReason(response.stopReason);
      const finishedAt = this.timestamp();
      this.executions.set(normalized.sessionId, {
        ...this.requireExecution(normalized.sessionId),
        phase: outcome,
        finishedAt,
        stopReason: response.stopReason,
        error: null,
        pendingPermissionCount: 0,
      });
      this.emitEvent({
        type: "turn-complete",
        sessionId: normalized.sessionId,
        turnId,
        outcome,
        stopReason: response.stopReason,
        receivedAt: finishedAt,
      });
    } catch (error: unknown) {
      if (!this.isCurrentPrompt(normalized.sessionId, turnId, generation, agent)) {
        return;
      }
      const converted = toRuntimeError("The Grok prompt failed", error, "", sensitiveValues);
      const finishedAt = this.timestamp();
      this.executions.set(normalized.sessionId, {
        ...this.requireExecution(normalized.sessionId),
        phase: "failed",
        finishedAt,
        stopReason: null,
        error: converted.message,
        pendingPermissionCount: 0,
      });
      this.emitEvent({
        type: "turn-failed",
        sessionId: normalized.sessionId,
        turnId,
        message: converted.message,
        receivedAt: finishedAt,
      });
      throw converted;
    } finally {
      this.clearCancelWatchdog(normalized.sessionId, turnId);
      if (this.isCurrentPrompt(normalized.sessionId, turnId, generation, agent)) {
        this.activePrompts.delete(normalized.sessionId);
        this.refreshOperationalPhase();
      }
    }
  }

  cancel(sessionId: string): Promise<void> {
    const normalizedSessionId = requireIdentifier(sessionId, "sessionId");
    const existingCancellation = this.activeCancellations.get(normalizedSessionId);
    if (existingCancellation) {
      return existingCancellation.promise;
    }

    const agent = this.requireAgent();
    const generation = this.lifecycleGeneration;
    const sensitiveValues = [...this.sensitiveValues];
    this.requireSession(normalizedSessionId);
    if (
      !this.activePrompts.has(normalizedSessionId) &&
      ![...this.pendingPermissions.values()].some(
        (pending) => pending.sessionId === normalizedSessionId,
      )
    ) {
      throw new Error("This Grok session does not have an active turn to cancel.");
    }

    const execution = this.requireExecution(normalizedSessionId);
    if (!execution.turnId) {
      throw new Error("This Grok session does not have an active turn to cancel.");
    }
    this.executions.set(normalizedSessionId, {
      ...execution,
      phase: "cancelling",
      error: null,
    });
    this.refreshOperationalPhase();

    let cancellation!: ActiveCancellation;
    const promise = this.performCancellation(
      normalizedSessionId,
      execution.turnId,
      generation,
      agent,
      sensitiveValues,
    ).finally(() => {
      if (this.activeCancellations.get(normalizedSessionId) === cancellation) {
        this.activeCancellations.delete(normalizedSessionId);
      }
    });
    cancellation = { turnId: execution.turnId, promise };
    this.activeCancellations.set(normalizedSessionId, cancellation);
    return promise;
  }

  private async performCancellation(
    sessionId: string,
    turnId: string,
    generation: number,
    agent: ClientContext,
    sensitiveValues: readonly string[],
  ): Promise<void> {
    this.startCancelWatchdog(sessionId, turnId);
    try {
      await withTimeout(
        agent.notify(methods.agent.session.cancel, { sessionId }),
        this.cancelTimeoutMs,
        "Timed out while sending the Grok cancellation notification.",
      );
    } catch (error: unknown) {
      if (!this.isCurrentCancellation(
        sessionId,
        turnId,
        generation,
        agent,
      )) {
        return;
      }
      const converted = toRuntimeError(
        "Unable to cancel the Grok prompt",
        error,
        "",
        sensitiveValues,
      );
      this.failRuntime(converted.message);
      throw converted;
    }

    if (!this.isCurrentCancellation(
      sessionId,
      turnId,
      generation,
      agent,
    )) {
      return;
    }
    this.cancelPermissionsForSession(sessionId);
    if (!this.isCurrentCancellation(
      sessionId,
      turnId,
      generation,
      agent,
    )) {
      return;
    }
  }

  async setSessionMode(sessionId: string, modeId: string): Promise<void> {
    const normalizedSessionId = requireIdentifier(sessionId, "sessionId");
    const normalizedModeId = requireIdentifier(modeId, "modeId");
    const agent = this.requireAgent();
    const sensitiveValues = [...this.sensitiveValues];
    const session = this.requireSession(normalizedSessionId);

    if (
      session.availableModes.length === 0 ||
      !session.availableModes.some((mode) => mode.id === normalizedModeId)
    ) {
      throw new Error(`Unknown or unavailable Grok session mode: ${normalizedModeId}`);
    }

    try {
      await agent.request(methods.agent.session.setMode, {
        sessionId: normalizedSessionId,
        modeId: normalizedModeId,
      });
      session.currentModeId = normalizedModeId;
      this.emitSyntheticSessionUpdate(normalizedSessionId, {
        sessionUpdate: "current_mode_update",
        currentModeId: normalizedModeId,
      });
    } catch (error: unknown) {
      throw toRuntimeError(
        "Unable to change the Grok session mode",
        error,
        "",
        sensitiveValues,
      );
    }
  }

  async setSessionConfig(
    sessionId: string,
    configId: string,
    value: string | boolean,
  ): Promise<void> {
    const normalizedSessionId = requireIdentifier(sessionId, "sessionId");
    const normalizedConfigId = requireIdentifier(configId, "configId");
    if (
      typeof value !== "boolean" &&
      (typeof value !== "string" || value.length > 16_384 || value.includes("\0"))
    ) {
      throw new TypeError("config value must be a boolean or a valid string of at most 16384 characters.");
    }

    const agent = this.requireAgent();
    const sensitiveValues = [...this.sensitiveValues];
    const session = this.requireSession(normalizedSessionId);
    const option = session.configOptions.find((candidate) => candidate.id === normalizedConfigId);
    if (!option) {
      throw new Error(`Unknown Grok session configuration option: ${normalizedConfigId}`);
    }
    if (option.readOnly) {
      throw new Error(`Grok session configuration option is read-only: ${normalizedConfigId}`);
    }

    const request = buildConfigRequest(normalizedSessionId, option, value);
    try {
      const response: SetSessionConfigOptionResponse = await agent.request(
        methods.agent.session.setConfigOption,
        request,
      );
      const capabilities = parseSessionCapabilities(response);
      this.applyParsedSessionCapabilities(capabilities);
      session.configOptions = capabilities.configOptions;
      this.emitSyntheticSessionUpdate(normalizedSessionId, {
        sessionUpdate: "config_option_update",
        configOptions: cloneSerializable(session.configOptions),
      });
    } catch (error: unknown) {
      throw toRuntimeError(
        "Unable to change the Grok session configuration",
        error,
        "",
        sensitiveValues,
      );
    }
  }

  async resolvePermission(response: PermissionResponsePayload): Promise<void> {
    const normalized = normalizePermissionResponse(response);
    const pending = this.pendingPermissions.get(normalized.requestId);
    if (!pending) {
      throw new Error(`Permission request is no longer pending: ${normalized.requestId}`);
    }

    const execution = this.executions.get(pending.sessionId);
    if (
      !this.activePrompts.has(pending.sessionId) ||
      (execution?.phase !== "working" && execution?.phase !== "waiting_permission")
    ) {
      this.finishPermission(normalized.requestId, { outcome: { outcome: "cancelled" } });
      return;
    }

    if (normalized.optionId !== null && !pending.optionIds.has(normalized.optionId)) {
      this.finishPermission(normalized.requestId, { outcome: { outcome: "cancelled" } });
      throw new Error("The selected permission option was not offered by Grok.");
    }

    this.finishPermission(
      normalized.requestId,
      normalized.optionId === null
        ? { outcome: { outcome: "cancelled" } }
        : {
            outcome: {
              outcome: "selected",
              optionId: normalized.optionId,
            },
          },
    );
  }

  private requireAgent(): ClientContext {
    if (!this.agent || !this.connection || this.connection.signal.aborted) {
      throw new Error("Grok is not connected.");
    }
    return this.agent;
  }

  private requireWorkspacePath(): string {
    if (!this.snapshot.workspacePath) {
      throw new Error("No Grok workspace is connected.");
    }
    return this.snapshot.workspacePath;
  }

  private requireSession(sessionId: string): SessionState {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Grok session is not active: ${sessionId}`);
    }
    return session;
  }

  private ensureExecution(sessionId: string): SessionExecutionSnapshot {
    const existing = this.executions.get(sessionId);
    if (existing) {
      return existing;
    }
    const execution = createIdleExecution(sessionId);
    this.executions.set(sessionId, execution);
    return execution;
  }

  private requireExecution(sessionId: string): SessionExecutionSnapshot {
    return this.executions.get(sessionId) ?? this.ensureExecution(sessionId);
  }

  private pendingPermissionCount(sessionId: string): number {
    let count = 0;
    for (const pending of this.pendingPermissions.values()) {
      if (pending.sessionId === sessionId) {
        count += 1;
      }
    }
    return count;
  }

  private timestamp(): string {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new Error("GrokRuntime now() must return a valid Date.");
    }
    return value.toISOString();
  }

  private handleSessionUpdate(notification: SessionNotification): void {
    const update = notification.update;
    const session = this.sessions.get(notification.sessionId);
    let rendererUpdate = sanitizeSessionUpdateForRenderer(update);
    if (update.sessionUpdate === "current_mode_update") {
      if (session) {
        session.currentModeId = update.currentModeId;
      }
    } else if (update.sessionUpdate === "config_option_update") {
      const capabilities = parseSessionCapabilities(update);
      this.applyParsedSessionCapabilities(capabilities);
      if (session) {
        session.configOptions = capabilities.configOptions;
      }
      rendererUpdate = {
        sessionUpdate: "config_option_update",
        configOptions: cloneSerializable(capabilities.configOptions),
      };
    } else if (update.sessionUpdate === "available_commands_update") {
      const availableCommands = parseAvailableCommands(update.availableCommands);
      if (session) {
        session.availableCommands = availableCommands;
      }
      rendererUpdate = {
        sessionUpdate: "available_commands_update",
        availableCommands: cloneSerializable(availableCommands),
      };
    } else if (
      update.sessionUpdate === "session_info_update" &&
      session &&
      typeof update.title === "string" &&
      update.title.trim()
    ) {
      session.title = update.title.trim().slice(0, MAX_TITLE_LENGTH);
    }

    const event: Extract<DesktopEvent, { type: "session-update" }> = {
      type: "session-update",
      sessionId: notification.sessionId,
      update: rendererUpdate,
      receivedAt: this.timestamp(),
    };
    const stagedUpdates = this.loadingSessionUpdates.get(notification.sessionId);
    if (stagedUpdates) stagedUpdates.push(event);
    else this.emitEvent(event);
  }

  private handlePermissionRequest(
    request: RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<RequestPermissionResponse> {
    const execution = this.executions.get(request.sessionId);
    const acceptsPermission = this.sessions.has(request.sessionId) &&
      this.activePrompts.has(request.sessionId) &&
      (execution?.phase === "working" || execution?.phase === "waiting_permission");
    if (
      !this.agent ||
      !acceptsPermission ||
      signal.aborted ||
      request.options.length === 0
    ) {
      return Promise.resolve({ outcome: { outcome: "cancelled" } });
    }
    if (request.options.some((option) => !isPermissionOptionKind(option.kind))) {
      this.emitEvent({
        type: "notice",
        level: "warning",
        message: "Grok returned an unsupported permission option. The request was cancelled.",
      });
      return Promise.resolve({ outcome: { outcome: "cancelled" } });
    }

    const requestId = requireIdentifier(this.createId(), "permissionRequestId");
    const expiresAt = new Date(
      Date.parse(this.timestamp()) + this.permissionTimeoutMs,
    ).toISOString();
    const payload: PermissionRequestPayload = {
      requestId,
      sessionId: request.sessionId,
      title: request.toolCall.title?.trim() || "Permission required",
      toolCall: cloneRecord(request.toolCall),
      options: request.options.map((option) => ({
        optionId: option.optionId,
        name: option.name,
        kind: option.kind,
      })),
      expiresAt,
    };

    return new Promise<RequestPermissionResponse>((resolve) => {
      const abort = (): void => {
        this.finishPermission(requestId, { outcome: { outcome: "cancelled" } });
      };
      signal.addEventListener("abort", abort, { once: true });
      const timeout = setTimeout(() => {
        if (!this.pendingPermissions.has(requestId)) {
          return;
        }
        this.finishPermission(requestId, { outcome: { outcome: "cancelled" } });
        this.emitEvent({
          type: "notice",
          level: "warning",
          message: `Permission request timed out and was cancelled: ${payload.title}`,
        });
      }, this.permissionTimeoutMs);
      timeout.unref();
      this.pendingPermissions.set(requestId, {
        sessionId: request.sessionId,
        optionIds: new Set(request.options.map((option) => option.optionId)),
        payload: cloneSerializable(payload),
        timeout,
        resolve,
        removeAbortListener: () => signal.removeEventListener("abort", abort),
      });
      if (signal.aborted) {
        this.finishPermission(requestId, { outcome: { outcome: "cancelled" } });
        return;
      }
      this.refreshOperationalPhase();
      this.emitEvent({ type: "permission-request", payload });
    });
  }

  private finishPermission(requestId: string, response: RequestPermissionResponse): void {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) {
      return;
    }
    this.pendingPermissions.delete(requestId);
    clearTimeout(pending.timeout);
    pending.removeAbortListener();
    pending.resolve(response);
    this.emitEvent({ type: "permission-resolved", requestId });
    this.refreshOperationalPhase();
  }

  private cancelPermissionsForSession(sessionId: string): void {
    for (const [requestId, pending] of [...this.pendingPermissions]) {
      if (pending.sessionId === sessionId) {
        this.finishPermission(requestId, { outcome: { outcome: "cancelled" } });
      }
    }
  }

  private cancelAllPermissions(): void {
    for (const requestId of [...this.pendingPermissions.keys()]) {
      this.finishPermission(requestId, { outcome: { outcome: "cancelled" } });
    }
  }

  private startCancelWatchdog(sessionId: string, turnId: string): void {
    const execution = this.executions.get(sessionId);
    if (
      !this.activePrompts.has(sessionId) ||
      execution?.turnId !== turnId ||
      execution.phase !== "cancelling"
    ) {
      return;
    }
    this.clearCancelWatchdog(sessionId);

    const timeout = setTimeout(() => {
      const watchdog = this.cancelWatchdogs.get(sessionId);
      const current = this.executions.get(sessionId);
      if (
        watchdog?.turnId !== turnId ||
        current?.turnId !== turnId ||
        current.phase !== "cancelling" ||
        !this.activePrompts.has(sessionId)
      ) {
        return;
      }
      this.cancelWatchdogs.delete(sessionId);
      this.failRuntime(
        `Grok did not confirm cancellation within ${Math.ceil(this.cancelTimeoutMs / 1_000)} seconds. The local Grok runtime was stopped.`,
      );
    }, this.cancelTimeoutMs);
    timeout.unref();
    this.cancelWatchdogs.set(sessionId, { turnId, timeout });
  }

  private clearCancelWatchdog(sessionId: string, turnId?: string): void {
    const watchdog = this.cancelWatchdogs.get(sessionId);
    if (!watchdog || (turnId && watchdog.turnId !== turnId)) {
      return;
    }
    clearTimeout(watchdog.timeout);
    this.cancelWatchdogs.delete(sessionId);
  }

  private clearAllCancelWatchdogs(): void {
    for (const watchdog of this.cancelWatchdogs.values()) {
      clearTimeout(watchdog.timeout);
    }
    this.cancelWatchdogs.clear();
  }

  private isCurrentPrompt(
    sessionId: string,
    turnId: string,
    generation: number,
    agent: ClientContext,
  ): boolean {
    return this.lifecycleGeneration === generation &&
      this.agent === agent &&
      this.activePrompts.has(sessionId) &&
      this.executions.get(sessionId)?.turnId === turnId;
  }

  private isCurrentCancellation(
    sessionId: string,
    turnId: string,
    generation: number,
    agent: ClientContext,
  ): boolean {
    const execution = this.executions.get(sessionId);
    return this.lifecycleGeneration === generation &&
      this.agent === agent &&
      this.activePrompts.has(sessionId) &&
      execution?.turnId === turnId &&
      execution.phase === "cancelling";
  }

  private async prepareMcpServersForSession(): Promise<McpServer[]> {
    const servers = await canonicalizeMcpServerExecutables(this.mcpServers);
    return toAcpMcpServers(servers, this.mcpInheritedEnvironment);
  }

  private handleReportedMcpServers(notification: unknown): void {
    const summary = parseReportedMcpServerCount(notification);
    if (!summary) {
      return;
    }
    if (
      summary.count === this.snapshot.reportedMcpServerCount &&
      summary.truncated === this.snapshot.reportedMcpServerCountTruncated
    ) {
      return;
    }
    this.updateSnapshot({
      reportedMcpServerCount: summary.count,
      reportedMcpServerCountTruncated: summary.truncated,
    });
  }

  private emitSyntheticSessionUpdate(
    sessionId: string,
    update: Record<string, unknown>,
  ): void {
    this.emitEvent({
      type: "session-update",
      sessionId,
      update: cloneRecord(update),
      receivedAt: this.timestamp(),
    });
  }

  private applySessionCapabilities(value: unknown): void {
    this.applyParsedSessionCapabilities(parseSessionCapabilities(value));
  }

  private applyParsedSessionCapabilities(
    state: ReturnType<typeof parseSessionCapabilities>,
  ): void {
    if (this.xaiApiKey) {
      assertModelMetadataDoesNotContainCredentials(state, this.xaiApiKey);
    }
    if (!state.currentModelId && state.availableModels.length === 0) {
      return;
    }
    this.updateSnapshot({
      ...(state.currentModelId ? { currentModelId: state.currentModelId } : {}),
      ...(state.availableModels.length > 0
        ? { availableModels: state.availableModels }
        : {}),
    });
  }

  private refreshOperationalPhase(): void {
    if (!this.agent || ["offline", "connecting", "stopping", "error"].includes(this.snapshot.phase)) {
      return;
    }

    for (const [sessionId, current] of this.executions) {
      const pendingPermissionCount = this.pendingPermissionCount(sessionId);
      let phase = current.phase;
      if (this.activePrompts.has(sessionId)) {
        if (current.phase !== "cancelling") {
          phase = pendingPermissionCount > 0 ? "waiting_permission" : "working";
        }
      } else if (pendingPermissionCount > 0) {
        phase = "waiting_permission";
      }
      this.executions.set(sessionId, {
        ...current,
        phase,
        pendingPermissionCount,
      });
    }

    const nextPhase = this.pendingPermissions.size > 0
      ? "waiting_permission"
      : this.activePrompts.size > 0
        ? "working"
        : "ready";
    this.updateSnapshot({
      phase: nextPhase,
      message: null,
      sessionExecutions: this.executionSnapshots(),
    });
  }

  private executionSnapshots(): SessionExecutionSnapshot[] {
    return [...this.executions.values()].map(cloneExecutionSnapshot);
  }

  private captureStandardError(child: ChildProcessWithoutNullStreams): void {
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (this.child !== child) {
        return;
      }
      this.stderrTail = appendTail(this.stderrTail, chunk, MAX_STDERR_TAIL_LENGTH);
    });
  }

  private observeProcess(child: ChildProcessWithoutNullStreams): void {
    child.once("error", (error) => {
      this.handleUnexpectedTermination(child, `Grok process error: ${describeError(error)}`);
    });
    child.once("exit", (exitCode, signal) => {
      if (this.expectedExits.has(child) || this.child !== child) {
        return;
      }
      this.handleUnexpectedTermination(child, formatProcessExit(exitCode, signal));
    });
  }

  private observeConnection(
    child: ChildProcessWithoutNullStreams,
    connection: ClientConnection,
  ): void {
    void connection.closed.then(
      () => {
        if (!this.expectedExits.has(child) && this.child === child) {
          this.handleUnexpectedTermination(child, "The Grok ACP connection closed unexpectedly.");
        }
      },
      (error: unknown) => {
        if (!this.expectedExits.has(child) && this.child === child) {
          this.handleUnexpectedTermination(
            child,
            `The Grok ACP connection failed: ${describeError(error)}`,
          );
        }
      },
    );
  }

  private handleUnexpectedTermination(
    child: ChildProcessWithoutNullStreams,
    reason: string,
  ): void {
    if (this.child !== child || this.expectedExits.has(child)) {
      return;
    }

    this.failRuntime(reason);
  }

  private failRuntime(reason: string): void {
    const child = this.child;
    const sensitiveValues = [...this.sensitiveValues];
    const safeReason = redactSensitiveText(reason, sensitiveValues);

    ++this.lifecycleGeneration;
    const connection = this.connection;
    const failedAt = this.timestamp();
    for (const [sessionId, execution] of this.executions) {
      if (isBusyExecution(execution.phase)) {
        this.executions.set(sessionId, {
          ...execution,
          phase: "failed",
          finishedAt: failedAt,
          stopReason: null,
          error: safeReason,
          pendingPermissionCount: 0,
        });
      }
    }
    this.child = null;
    this.connection = null;
    this.agent = null;
    this.xaiApiKeyConfigured = false;
    this.mcpServers = [];
    this.mcpInheritedEnvironment = {};
    this.activePrompts.clear();
    this.activeCancellations.clear();
    this.clearAllCancelWatchdogs();
    this.cancelAllPermissions();
    try {
      connection?.close(new Error(safeReason));
    } catch {
      // The transport is already unusable; process cleanup below is authoritative.
    }
    if (child) {
      this.expectedExits.add(child);
    }
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill();
    }

    const message = appendDiagnostic(safeReason, this.stderrTail, sensitiveValues);
    this.stderrTail = "";
    try {
      this.updateSnapshot({
        phase: "error",
        reportedMcpServerCount: 0,
        reportedMcpServerCountTruncated: false,
        message,
        sessionExecutions: this.executionSnapshots(),
      });
      this.emitEvent({ type: "notice", level: "error", message });
    } finally {
      this.sensitiveValues = [];
      this.xaiApiKey = null;
    }
  }

  private async teardownConnection(): Promise<void> {
    const child = this.child;
    const connection = this.connection;
    this.child = null;
    this.connection = null;
    this.agent = null;
    this.xaiApiKeyConfigured = false;
    this.xaiApiKey = null;
    this.mcpServers = [];
    this.mcpInheritedEnvironment = {};
    this.sessions.clear();
    this.clearAllCancelWatchdogs();
    this.activePrompts.clear();
    this.activeCancellations.clear();
    this.cancelAllPermissions();
    this.executions.clear();
    this.loadingSessionUpdates.clear();

    if (child) {
      this.expectedExits.add(child);
    }
    try {
      await yieldToProtocolHandlers();

      try {
        connection?.close();
      } catch {
        // Closing is idempotent from the runtime's perspective.
      }

      if (!child || child.exitCode !== null || child.signalCode !== null) {
        return;
      }

      child.kill();
      await waitForExit(child, GRACEFUL_EXIT_TIMEOUT_MS);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await waitForExit(child, FORCED_EXIT_TIMEOUT_MS);
      }
    } finally {
      this.stderrTail = "";
      this.sensitiveValues = [];
      this.xaiApiKey = null;
    }
  }

  private assertCurrentGeneration(generation: number): void {
    if (generation !== this.lifecycleGeneration) {
      throw new Error("The Grok connection attempt was cancelled.");
    }
  }

  private updateSnapshot(patch: Partial<RuntimeSnapshot>): void {
    this.snapshot = {
      ...this.snapshot,
      ...patch,
      availableModels: patch.availableModels
        ? patch.availableModels.map(cloneModelInfo)
        : this.snapshot.availableModels,
      authMethods: patch.authMethods
        ? patch.authMethods.map((method) => ({ ...method }))
        : this.snapshot.authMethods,
      capabilities: patch.capabilities
        ? cloneRuntimeCapabilities(patch.capabilities)
        : this.snapshot.capabilities,
      sessionExecutions: patch.sessionExecutions
        ? patch.sessionExecutions.map(cloneExecutionSnapshot)
        : this.snapshot.sessionExecutions,
    };
    this.emitEvent({ type: "runtime", snapshot: this.getSnapshot() });
  }

  private emitEvent(event: DesktopEvent): void {
    try {
      this.emit(redactSerializableSecrets(event, this.sensitiveValues));
    } catch {
      // A renderer disappearing must not take down the Grok subprocess.
    }
  }
}

function sanitizeSessionUpdateForRenderer(update: Record<string, unknown>): Record<string, unknown> {
  const cloned = cloneRecord(update);
  if (update.sessionUpdate === "user_message_chunk" && update.content !== undefined) {
    cloned.content = sanitizePromptEchoContent(update.content);
  }
  return cloned;
}

function sanitizePromptEchoContent(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizePromptEchoContent);
  }
  const content = asRecord(value);
  if (content?.type === "image") {
    return {
      type: "image",
      ...(typeof content.mimeType === "string" ? { mimeType: content.mimeType } : {}),
      ...(typeof content.uri === "string" ? { uri: content.uri } : {}),
    };
  }
  if (content?.type !== "resource") {
    return cloneSerializable(value);
  }
  const resource = asRecord(content.resource);
  return {
    type: "resource",
    resource: {
      ...(typeof resource?.uri === "string" ? { uri: resource.uri } : {}),
      ...(typeof resource?.mimeType === "string" ? { mimeType: resource.mimeType } : {}),
    },
  };
}

function createOfflineSnapshot(): RuntimeSnapshot {
  return {
    phase: "offline",
    permissionMode: null,
    xaiApiBaseUrl: null,
    xaiApiKeyConfigured: false,
    mcpConfigured: false,
    reportedMcpServerCount: 0,
    reportedMcpServerCountTruncated: false,
    workspacePath: null,
    executablePath: null,
    grokVersion: null,
    protocolVersion: null,
    currentModelId: null,
    availableModels: [],
    authMethods: [],
    capabilities: createEmptyRuntimeCapabilities(),
    sessionExecutions: [],
    message: null,
  };
}

function cloneSnapshot(snapshot: RuntimeSnapshot): RuntimeSnapshot {
  return {
    ...snapshot,
    availableModels: snapshot.availableModels.map(cloneModelInfo),
    authMethods: snapshot.authMethods.map((method) => ({ ...method })),
    capabilities: cloneRuntimeCapabilities(snapshot.capabilities),
    sessionExecutions: snapshot.sessionExecutions.map(cloneExecutionSnapshot),
  };
}

function cloneModelInfo(model: ModelInfo): ModelInfo {
  return {
    ...model,
    ...(model.reasoningEfforts
      ? { reasoningEfforts: model.reasoningEfforts.map((effort) => ({ ...effort })) }
      : {}),
  };
}

function cloneRuntimeCapabilities(
  capabilities: RuntimeCapabilities,
): RuntimeCapabilities {
  return {
    prompt: { ...capabilities.prompt },
    mcp: { ...capabilities.mcp },
    session: { ...capabilities.session },
    extensions: { ...capabilities.extensions },
  };
}

function cloneMcpServers(
  servers: readonly McpServerConfig[],
): McpServerConfig[] {
  return servers.map((server) => server.type === "stdio"
    ? {
        ...server,
        args: [...server.args],
        env: server.env.map((variable) => ({ ...variable })),
      }
    : {
        ...server,
        headers: server.headers.map((header) => ({ ...header })),
      });
}

export function mcpEnvironmentMaskFromLaunch(
  environment: Readonly<NodeJS.ProcessEnv>,
): Readonly<Record<string, string | undefined>> {
  return Object.freeze(Object.fromEntries(
    Object.keys(environment).map((name) => [name, undefined]),
  ));
}

export function toAcpMcpServers(
  servers: readonly McpServerConfig[],
  inheritedEnvironment: Readonly<Record<string, string | undefined>> = process.env,
  platform = process.platform,
): McpServer[] {
  return servers.map((server): McpServer => {
    if (server.type === "stdio") {
      return {
        name: server.name,
        command: server.command,
        args: [...server.args],
        env: isolateMcpStdioEnvironment(server.env, inheritedEnvironment, platform),
      };
    }
    return server.type === "http" ? {
        type: "http",
        name: server.name,
        url: server.url,
        headers: server.headers.map((header) => ({ ...header })),
      }
    : {
        type: "sse",
        name: server.name,
        url: server.url,
        headers: server.headers.map((header) => ({ ...header })),
      };
  });
}

function createIdleExecution(sessionId: string): SessionExecutionSnapshot {
  return {
    sessionId,
    phase: "idle",
    turnId: null,
    startedAt: null,
    finishedAt: null,
    stopReason: null,
    error: null,
    pendingPermissionCount: 0,
  };
}

function cloneExecutionSnapshot(
  execution: SessionExecutionSnapshot,
): SessionExecutionSnapshot {
  return { ...execution };
}

export function outcomeFromStopReason(
  stopReason: string,
): Exclude<TurnOutcome, "failed"> {
  switch (stopReason) {
    case "end_turn":
    case "max_tokens":
    case "max_turn_requests":
    case "refusal":
    case "cancelled":
      return stopReason;
    default:
      throw new Error(`Unsupported Grok stop reason: ${stopReason}`);
  }
}

function isBusyExecution(phase: SessionExecutionSnapshot["phase"]): boolean {
  return phase === "working" || phase === "waiting_permission" || phase === "cancelling";
}

function requirePositiveTimeout(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

export function assertAdvertisedModelSelection(
  modelId: string | null,
  executablePath: string,
  snapshot: RuntimeSnapshot,
): void {
  if (modelId === null) {
    return;
  }
  const sameExecutable = snapshot.executablePath === executablePath;
  const advertised = snapshot.availableModels.some((model) => model.id === modelId);
  if (!sameExecutable || !advertised) {
    throw new Error(
      "The requested model was not advertised by the currently connected Grok runtime.",
    );
  }
}

export function assertAdvertisedReasoningEffort(
  reasoningEffort: string | null,
  modelId: string | null,
  executablePath: string,
  snapshot: RuntimeSnapshot,
): void {
  if (reasoningEffort === null) {
    return;
  }
  if (modelId === null || snapshot.executablePath !== executablePath) {
    throw new Error(
      "The requested reasoning effort was not advertised for the selected Grok model.",
    );
  }
  const model = snapshot.availableModels.find((candidate) => candidate.id === modelId);
  if (!model?.reasoningEfforts?.some((candidate) => candidate.id === reasoningEffort)) {
    throw new Error(
      "The requested reasoning effort was not advertised for the selected Grok model.",
    );
  }
}

async function normalizeConnectRequest(request: ConnectRequest): Promise<NormalizedConnectRequest> {
  if (!isRecord(request)) {
    throw new TypeError("connect request must be an object.");
  }

  const workspacePath = await requireExistingPath(request.workspacePath, "workspacePath", true);
  const requestedExecutable = request.executablePath ?? defaultGrokExecutablePath();
  const executablePath = await requireExistingPath(
    requestedExecutable,
    "executablePath",
    false,
  );
  await access(
    executablePath,
    process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK,
  );

  const modelId = request.modelId === undefined
    ? null
    : requireIdentifier(request.modelId, "modelId");
  const reasoningEffort = request.reasoningEffort === undefined
    ? null
    : requireIdentifier(request.reasoningEffort, "reasoningEffort");
  if (request.alwaysApprove !== undefined && typeof request.alwaysApprove !== "boolean") {
    throw new TypeError("alwaysApprove must be a boolean.");
  }
  const permissionMode = request.permissionMode === undefined
    ? request.alwaysApprove ? "always_approve" : "default"
    : requirePermissionMode(request.permissionMode);
  const { xaiApiBaseUrl, xaiApiKey } = normalizeRequiredXaiConnection(
    request.xaiApiBaseUrl,
    request.xaiApiKey,
  );
  const mcpServers = await canonicalizeMcpServerExecutables(
    normalizeMcpServers(request.mcpServers),
  );
  assertStdioMcpExecutionApproved(mcpServers, request.allowStdioMcpExecution);

  return {
    workspacePath,
    executablePath,
    modelId,
    reasoningEffort,
    permissionMode,
    xaiApiBaseUrl,
    xaiApiKey,
    mcpServers,
  };
}

function requirePermissionMode(value: unknown): PermissionModePreference {
  if (value !== "default" && value !== "auto" && value !== "always_approve") {
    throw new TypeError("permissionMode must be default, auto, or always_approve.");
  }
  return value;
}

async function requireExistingPath(
  value: unknown,
  name: string,
  requireDirectory: boolean,
): Promise<string> {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > MAX_PATH_LENGTH ||
    value.includes("\0") ||
    !path.isAbsolute(value)
  ) {
    throw new TypeError(`${name} must be a valid absolute path.`);
  }

  try {
    const canonicalPath = await realpath(value);
    const entry = await stat(canonicalPath);
    if (requireDirectory ? !entry.isDirectory() : !entry.isFile()) {
      throw new Error(
        `${name} must point to an existing ${requireDirectory ? "directory" : "file"}.`,
      );
    }
    return canonicalPath;
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith(`${name} must point`)) {
      throw error;
    }
    throw new Error(`${name} does not exist or is not accessible.`, { cause: error });
  }
}

function assertLocalMcpExecutablePath(value: unknown): void {
  if (
    process.platform === "win32" &&
    typeof value === "string" &&
    (/^[\\/]{2}/u.test(value) || /^\\\\[.?]\\/u.test(value))
  ) {
    throw new TypeError("MCP stdio 程序必须位于本机磁盘，不能使用 UNC 或设备路径。");
  }
}

export async function requireMcpExecutablePath(value: unknown): Promise<string> {
  assertLocalMcpExecutablePath(value);
  const executablePath = await requireExistingPath(value, "mcpExecutablePath", false);
  assertLocalMcpExecutablePath(executablePath);
  if (
    process.platform === "win32" &&
    path.extname(executablePath).toLocaleLowerCase("en-US") !== ".exe"
  ) {
    throw new TypeError("MCP stdio 程序必须是 .exe 可执行文件。");
  }
  return executablePath;
}

export function assertStdioMcpExecutionApproved(
  servers: readonly McpServerConfig[],
  approved: true | undefined,
): void {
  if (servers.some((server) => server.type === "stdio") && approved !== true) {
    throw new Error("Local MCP execution was not approved.");
  }
}

async function canonicalizeMcpServerExecutables(
  servers: readonly McpServerConfig[],
): Promise<McpServerConfig[]> {
  return Promise.all(servers.map(async (server) => server.type === "stdio"
    ? { ...server, command: await requireMcpExecutablePath(server.command) }
    : server));
}

function defaultGrokExecutablePath(): string {
  return path.join(
    os.homedir(),
    ".grok",
    "bin",
    process.platform === "win32" ? "grok.exe" : "grok",
  );
}

function normalizePromptRequest(
  request: PromptRequest,
  workspacePath: string,
): PromptRequest {
  if (!isRecord(request)) {
    throw new TypeError("prompt request must be an object.");
  }
  const sessionId = requireIdentifier(request.sessionId, "sessionId");
  if (
    typeof request.text !== "string" ||
    request.text.length === 0 ||
    request.text.length > MAX_PROMPT_LENGTH
  ) {
    throw new TypeError(`prompt text must contain between 1 and ${MAX_PROMPT_LENGTH} characters.`);
  }
  const contextPaths = normalizePromptContextPaths(request.contextPaths, workspacePath);
  return {
    sessionId,
    text: request.text,
    ...(contextPaths.length > 0 ? { contextPaths } : {}),
  };
}

function normalizePromptContextPaths(
  value: unknown,
  workspacePath: string,
): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > MAX_PROMPT_CONTEXT_FILES) {
    throw new TypeError(`contextPaths must contain at most ${MAX_PROMPT_CONTEXT_FILES} files.`);
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (
      typeof candidate !== "string" ||
      !path.isAbsolute(candidate) ||
      candidate.length > MAX_PATH_LENGTH ||
      candidate.includes("\0") ||
      !isPathInsideWorkspace(workspacePath, candidate) &&
      !isSupportedExternalImagePath(candidate)
    ) {
      throw new TypeError("Every prompt context path must be an absolute file inside the current workspace or a supported image.");
    }
    const key = process.platform === "win32"
      ? candidate.toLocaleLowerCase("en-US")
      : candidate;
    if (!seen.has(key)) {
      seen.add(key);
      normalized.push(candidate);
    }
  }
  return normalized;
}

function isSupportedExternalImagePath(candidate: string): boolean {
  return /\.(?:gif|jpe?g|png|webp)$/iu.test(candidate);
}

function createPromptContextBlocks(
  contextPaths: readonly string[],
  preparedFiles: readonly PreparedPromptContextFile[],
  preparedImages: readonly PreparedPromptImage[],
  allowEmbeddedContext: boolean,
): ContentBlock[] {
  const contextKeys = new Set(contextPaths.map(contextPathKey));
  const preparedByPath = new Map<string, PreparedPromptContextFile>();
  const preparedImagesByPath = new Map<string, PreparedPromptImage>();
  for (const file of preparedFiles) {
    const key = contextPathKey(file.path);
    if (!contextKeys.has(key)) {
      throw new TypeError("Prepared prompt context does not match the requested workspace files.");
    }
    preparedByPath.set(key, file);
  }
  for (const image of preparedImages) {
    const key = contextPathKey(image.path);
    if (!contextKeys.has(key) || preparedByPath.has(key)) {
      throw new TypeError("Prepared prompt images do not match the requested workspace files.");
    }
    preparedImagesByPath.set(key, image);
  }

  return contextPaths.map((contextPath): ContentBlock => {
    const key = contextPathKey(contextPath);
    const preparedImage = preparedImagesByPath.get(key);
    const uri = pathToFileURL(contextPath).href;
    if (preparedImage) {
      return {
        type: "image",
        data: preparedImage.data,
        mimeType: preparedImage.mimeType,
        uri,
      };
    }
    const prepared = preparedByPath.get(key);
    if (allowEmbeddedContext && prepared?.text !== undefined) {
      return {
        type: "resource",
        resource: {
          uri,
          text: prepared.text,
          ...(prepared.mimeType ? { mimeType: prepared.mimeType } : {}),
        },
      };
    }
    return {
      type: "resource_link",
      uri,
      name: prepared?.name ?? path.basename(contextPath),
      ...(prepared ? { size: prepared.size } : {}),
    };
  });
}

function contextPathKey(contextPath: string): string {
  return process.platform === "win32"
    ? contextPath.toLocaleLowerCase("en-US")
    : contextPath;
}

function isPathInsideWorkspace(workspacePath: string, candidatePath: string): boolean {
  const relative = path.relative(workspacePath, candidatePath);
  return relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative);
}

function normalizePermissionResponse(
  response: PermissionResponsePayload,
): PermissionResponsePayload {
  if (!isRecord(response)) {
    throw new TypeError("permission response must be an object.");
  }
  const requestId = requireIdentifier(response.requestId, "requestId");
  const optionId = response.optionId === null
    ? null
    : requireIdentifier(response.optionId, "optionId");
  return { requestId, optionId };
}

function requireIdentifier(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    value.includes("\0")
  ) {
    throw new TypeError(`${name} must be a non-empty string of at most ${MAX_IDENTIFIER_LENGTH} characters.`);
  }
  return value.trim();
}

function normalizeOptionalTitle(title: unknown): string | null {
  if (title === undefined) {
    return null;
  }
  if (typeof title !== "string" || !title.trim() || title.length > MAX_TITLE_LENGTH) {
    throw new TypeError(`title must be a non-empty string of at most ${MAX_TITLE_LENGTH} characters.`);
  }
  return title.trim();
}

function assertSupportedProtocol(protocolVersion: number): void {
  if (protocolVersion !== PROTOCOL_VERSION) {
    throw new Error(
      `Unsupported ACP protocol version ${protocolVersion}; this client supports ${PROTOCOL_VERSION}.`,
    );
  }
}

function assertModelMetadataDoesNotContainCredentials(
  state: {
    currentModelId: string | null;
    availableModels: readonly ModelInfo[];
    configOptions?: readonly SessionConfigOption[];
  },
  apiKey: string,
): void {
  const values: Array<string | null | undefined> = [state.currentModelId];
  for (const model of state.availableModels) {
    values.push(
      model.id,
      model.name,
      model.description,
      model.reasoningEffort,
    );
    for (const effort of model.reasoningEfforts ?? []) {
      values.push(effort.id, effort.name, effort.description);
    }
  }
  for (const option of state.configOptions ?? []) {
    if (option.category !== "model") continue;
    values.push(
      option.id,
      option.name,
      option.description,
      typeof option.currentValue === "string" ? option.currentValue : undefined,
    );
    for (const candidate of option.options ?? []) {
      values.push(candidate.value, candidate.name, candidate.description);
    }
  }
  if (values.some((value) =>
    typeof value === "string" && containsSensitiveText(value, [apiKey]))) {
    throw new Error("Grok ACP returned model metadata containing API credentials.");
  }
}

function parseInitialization(
  response: InitializeResponse,
  requestedModelId: string | null,
): {
  grokVersion: string | null;
  currentModelId: string | null;
  availableModels: ModelInfo[];
  authMethods: AuthMethodInfo[];
  capabilities: RuntimeCapabilities;
} {
  const raw = response as unknown as Record<string, unknown>;
  const meta = asRecord(raw._meta);
  const agentInfo = asRecord(raw.agentInfo);
  const capabilities = parseAgentCapabilities(raw.agentCapabilities ?? {});
  const modelState = firstRecord(
    raw.modelState,
    meta?.modelState,
    asRecord(raw.agentCapabilities)?.modelState,
  );
  const parsedModels = parseSessionCapabilities({
    models: raw.models,
    modelState,
    _meta: raw._meta,
  });

  return {
    grokVersion:
      readNonEmptyString(agentInfo?.version) ??
      readNonEmptyString(meta?.agentVersion) ??
      null,
    currentModelId: parsedModels.currentModelId ?? requestedModelId,
    availableModels: parsedModels.availableModels,
    authMethods: parseAuthMethods(raw.authMethods),
    capabilities,
  };
}

function parseAuthMethods(value: unknown): AuthMethodInfo[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const methodsFound = value.flatMap((candidate): AuthMethodInfo[] => {
    const method = asRecord(candidate);
    const id = readNonEmptyString(method?.id);
    if (!method || !id) {
      return [];
    }
    const description = readNonEmptyString(method.description);
    return [{
      id,
      name: readNonEmptyString(method.name) ?? id,
      ...(description ? { description } : {}),
    }];
  });
  return deduplicateById(methodsFound);
}

function createSessionState(
  sessionId: string,
  title: string,
  response: NewSessionResponse | LoadSessionResponse,
  loaded: boolean,
): SessionState {
  const raw = response as unknown as Record<string, unknown>;
  const capabilities = parseSessionCapabilities(raw);
  const commands = parseSessionAvailableCommands(raw);
  return {
    sessionId,
    title,
    currentModeId: response.modes?.currentModeId ?? null,
    availableModes: parseModes(response.modes?.availableModes),
    configOptions: capabilities.configOptions,
    availableCommands: commands.commands,
    loaded,
  };
}

function mergeSessionState(
  state: SessionState,
  title: string,
  response: NewSessionResponse | LoadSessionResponse,
  loaded: boolean,
): SessionState {
  const raw = response as unknown as Record<string, unknown>;
  const capabilities = parseSessionCapabilities(raw);
  const commands = parseSessionAvailableCommands(raw);
  return {
    sessionId: state.sessionId,
    title,
    currentModeId: response.modes?.currentModeId ?? state.currentModeId,
    availableModes: response.modes
      ? parseModes(response.modes.availableModes)
      : state.availableModes,
    configOptions: hasSessionConfigPayload(raw)
      ? capabilities.configOptions
      : state.configOptions,
    availableCommands: commands.present ? commands.commands : state.availableCommands,
    loaded,
  };
}

function parseModes(value: unknown): SessionModeOption[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((candidate): SessionModeOption[] => {
    const mode = asRecord(candidate);
    const id = readNonEmptyString(mode?.id);
    if (!mode || !id) {
      return [];
    }
    const description = readNonEmptyString(mode.description);
    return [{
      id,
      name: readNonEmptyString(mode.name) ?? id,
      ...(description ? { description } : {}),
    }];
  });
}

function hasSessionConfigPayload(response: Record<string, unknown>): boolean {
  if (Array.isArray(response.configOptions)) {
    return true;
  }
  const meta = asRecord(response._meta);
  const extension = asRecord(meta?.["x.ai/sessionConfig"]);
  return Array.isArray(extension?.options);
}

function parseSessionAvailableCommands(
  response: Record<string, unknown>,
): { present: boolean; commands: AvailableCommand[] } {
  if (Array.isArray(response.availableCommands)) {
    return {
      present: true,
      commands: parseAvailableCommands(response.availableCommands),
    };
  }
  const meta = asRecord(response._meta);
  if (Array.isArray(meta?.availableCommands)) {
    return {
      present: true,
      commands: parseAvailableCommands(meta.availableCommands),
    };
  }
  return { present: false, commands: [] };
}

function titleFromResponse(response: NewSessionResponse | LoadSessionResponse): string | null {
  const raw = response as unknown as Record<string, unknown>;
  const metadata = asRecord(raw._meta);
  const sessionDetail = asRecord(metadata?.["x.ai/sessionDetail"]);
  const title =
    readNonEmptyString(raw.title) ??
    readNonEmptyString(metadata?.title) ??
    readNonEmptyString(sessionDetail?.title);
  return title?.slice(0, MAX_TITLE_LENGTH) ?? null;
}

function toSessionReadyPayload(
  session: SessionState,
  workspacePath: string,
  loaded: boolean,
): SessionReadyPayload {
  return {
    sessionId: session.sessionId,
    workspacePath,
    title: session.title,
    currentModeId: session.currentModeId,
    availableModes: session.availableModes.map((mode) => ({ ...mode })),
    configOptions: cloneSerializable(session.configOptions),
    availableCommands: cloneSerializable(session.availableCommands),
    loaded,
  };
}

function cloneSessionReadyPayload(payload: SessionReadyPayload): SessionReadyPayload {
  return {
    ...payload,
    availableModes: payload.availableModes.map((mode) => ({ ...mode })),
    configOptions: cloneSerializable(payload.configOptions),
    availableCommands: cloneSerializable(payload.availableCommands),
  };
}

function buildConfigRequest(
  sessionId: string,
  option: SessionConfigOption,
  value: string | boolean,
): SetSessionConfigOptionRequest {
  if (option.type === "boolean") {
    if (typeof value !== "boolean" && value !== "true" && value !== "false") {
      throw new Error(`Configuration option ${option.id} requires true or false.`);
    }
    return {
      sessionId,
      configId: option.id,
      type: "boolean",
      value: typeof value === "boolean" ? value : value === "true",
    };
  }

  if (typeof value !== "string") {
    throw new Error(`Configuration option ${option.id} requires a string value.`);
  }
  const allowedValues = flattenConfigValues(option.options);
  if (!allowedValues.has(value)) {
    throw new Error(`Value is not available for Grok configuration option ${option.id}.`);
  }
  return { sessionId, configId: option.id, value };
}

function flattenConfigValues(options: unknown): Set<string> {
  const values = new Set<string>();
  if (!Array.isArray(options)) {
    return values;
  }
  for (const candidate of options) {
    const record = asRecord(candidate);
    const directValue = readNonEmptyString(record?.value);
    if (directValue) {
      values.add(directValue);
    }
    if (Array.isArray(record?.options)) {
      for (const groupedCandidate of record.options) {
        const groupedValue = readNonEmptyString(asRecord(groupedCandidate)?.value);
        if (groupedValue) {
          values.add(groupedValue);
        }
      }
    }
  }
  return values;
}

function deduplicateById<T extends { id: string }>(values: readonly T[]): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (seen.has(value.id)) {
      return false;
    }
    seen.add(value.id);
    return true;
  });
}

function cloneRecord(value: unknown): Record<string, unknown> {
  const record = asRecord(value);
  return record ? cloneSerializable(record) : {};
}

function cloneSerializable<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as T;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function firstRecord(...values: unknown[]): Record<string, unknown> | null {
  for (const value of values) {
    const record = asRecord(value);
    if (record) {
      return record;
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function waitForSpawn(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<void> {
  if (child.pid !== undefined) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      child.off("spawn", onSpawn);
      child.off("error", onError);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const onSpawn = (): void => finish();
    const onError = (error: Error): void => finish(error);
    child.once("spawn", onSpawn);
    child.once("error", onError);
    const timeout = setTimeout(
      () => finish(new Error("Timed out while starting the Grok process.")),
      timeoutMs,
    );
    timeout.unref();
  });
}

async function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      child.off("exit", finish);
      resolve();
    };
    child.once("exit", finish);
    const timeout = setTimeout(finish, timeoutMs);
    timeout.unref();
  });
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function yieldToProtocolHandlers(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function formatProcessExit(exitCode: number | null, signal: NodeJS.Signals | null): string {
  if (signal) {
    return `Grok exited after receiving ${signal}.`;
  }
  return `Grok exited with code ${exitCode ?? "unknown"}.`;
}

function appendTail(previous: string, chunk: string, maximum: number): string {
  const combined = previous + chunk;
  return combined.length <= maximum ? combined : combined.slice(-maximum);
}

function appendDiagnostic(
  message: string,
  stderr: string,
  sensitiveValues: readonly string[] = [],
): string {
  const safeMessage = redactSensitiveText(message, sensitiveValues);
  const diagnostic = redactSensitiveText(stderr, sensitiveValues)
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 1_000);
  return diagnostic ? `${safeMessage} Grok reported: ${diagnostic}` : safeMessage;
}

function toRuntimeError(
  action: string,
  error: unknown,
  stderr = "",
  sensitiveValues: readonly string[] = [],
): Error {
  const detail = appendDiagnostic(describeError(error), stderr, sensitiveValues);
  return new Error(`${action}: ${detail}`);
}

function collectSensitiveValues(
  ...values: Array<string | null | undefined>
): string[] {
  return [
    ...new Set(
      values.filter(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      ),
    ),
  ].sort((left, right) => right.length - left.length);
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  return "An unknown error occurred.";
}
