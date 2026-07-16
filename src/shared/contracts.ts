export type RuntimePhase =
  | "offline"
  | "connecting"
  | "ready"
  | "working"
  | "waiting_permission"
  | "stopping"
  | "error";

export type SessionExecutionPhase =
  | "idle"
  | "working"
  | "waiting_permission"
  | "cancelling"
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "failed"
  | "cancelled";

export interface SessionExecutionSnapshot {
  sessionId: string;
  phase: SessionExecutionPhase;
  turnId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  stopReason: string | null;
  error: string | null;
  pendingPermissionCount: number;
}

export interface GrokInstallation {
  found: boolean;
  executablePath: string | null;
  version: string | null;
  error: string | null;
}

export interface RecentWorkspace {
  path: string;
  label: string;
  lastOpenedAt: string;
}

export const MAX_PROMPT_CONTEXT_FILES = 12;

export interface ContextFileReference {
  path: string;
  name: string;
  relativePath: string;
  size: number;
  kind: "file" | "image";
  mimeType: string | null;
}

export interface StoredSession {
  sessionId: string;
  workspacePath: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export type PermissionModePreference = "default" | "auto" | "always_approve";
export type ThemePreference = "system" | "light" | "dark";

export interface DesktopSettingsSnapshot {
  grokExecutablePath: string | null;
  /** Non-sensitive normalized endpoint; credentials must never be embedded in this URL. */
  xaiApiBaseUrl: string | null;
  permissionMode: PermissionModePreference;
  themePreference: ThemePreference;
  lastWorkspacePath: string | null;
  recentWorkspaces: RecentWorkspace[];
  recentSessions: StoredSession[];
}

export interface BootstrapPayload {
  installation: GrokInstallation;
  settings: DesktopSettingsSnapshot;
  xaiCredential: XaiCredentialStatus;
  platform: string;
  appVersion: string;
}

export interface XaiCredentialStatus {
  available: boolean;
  scope: string | null;
  secureStorageAvailable: boolean;
}

export type McpHttpTransport = "http" | "sse";
export type McpTransport = McpHttpTransport | "stdio";

export interface McpHttpHeader {
  name: string;
  /** Header values are per-process secrets and must never enter snapshots or settings. */
  value: string;
}

export interface McpHttpServerConfig {
  type: McpHttpTransport;
  name: string;
  url: string;
  headers: McpHttpHeader[];
}

export interface McpStdioEnvironmentVariable {
  name: string;
  /** Environment values are per-process secrets and must never be persisted. */
  value: string;
}

export interface McpStdioServerConfig {
  type: "stdio";
  name: string;
  /** Canonical absolute executable path. Shell commands and scripts are not accepted. */
  command: string;
  /** Exact argument vector. The desktop never parses a shell command line. */
  args: string[];
  /** Explicit environment only; inherited sensitive variables are blanked in Main. */
  env: McpStdioEnvironmentVariable[];
}

export type McpServerConfig = McpHttpServerConfig | McpStdioServerConfig;

export interface ConnectRequest {
  workspacePath: string;
  executablePath?: string;
  modelId?: string;
  /** A model-advertised reasoning level used only for this Grok process. */
  reasoningEffort?: string;
  permissionMode?: PermissionModePreference;
  /** @deprecated Compatibility for older renderer builds. Prefer permissionMode. */
  alwaysApprove?: boolean;
  /** Explicit endpoint for this connection. The desktop never falls back to Grok login. */
  xaiApiBaseUrl: string;
  /** Per-process secret. It must never be copied into settings, snapshots, or events. */
  xaiApiKey: string;
  /** Per-process MCP configuration. Header values must never be persisted or echoed. */
  mcpServers?: McpServerConfig[];
  /** Required literal consent when any stdio MCP executable may be launched. */
  allowStdioMcpExecution?: true;
}

export type XaiApiCredentialRequest =
  | { xaiApiKey: string; useStoredXaiApiKey?: never }
  | { xaiApiKey?: never; useStoredXaiApiKey: true };

export type DesktopConnectRequest = Omit<ConnectRequest, "xaiApiKey"> &
  XaiApiCredentialRequest;

export interface AuthMethodInfo {
  id: string;
  name: string;
  description?: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  description?: string;
  reasoningEffort?: string;
  reasoningEfforts?: ReasoningEffortInfo[];
}

export interface DiscoverModelsRequest {
  workspacePath: string;
  executablePath?: string;
  xaiApiBaseUrl: string;
  /** Per-process secret used only by the short-lived ACP discovery runtime. */
  xaiApiKey: string;
}

export type DesktopDiscoverModelsRequest = Omit<DiscoverModelsRequest, "xaiApiKey"> &
  XaiApiCredentialRequest;

export interface DiscoverModelsResult {
  resolvedBaseUrl: string;
  currentModelId: string | null;
  models: ModelInfo[];
}

export interface ReasoningEffortInfo {
  id: string;
  name: string;
  description?: string;
  isDefault: boolean;
}

export interface RuntimeCapabilities {
  prompt: {
    image: boolean;
    audio: boolean;
    embeddedContext: boolean;
  };
  mcp: {
    /** Stdio is a baseline ACP v1 transport; product policy may still keep it disabled. */
    stdio: boolean;
    http: boolean;
    sse: boolean;
    acp: boolean;
  };
  session: {
    load: boolean;
    list: boolean;
    delete: boolean;
    additionalDirectories: boolean;
    fork: boolean;
    resume: boolean;
    close: boolean;
  };
  extensions: {
    fsNotify: boolean;
    hooksCanDeny: boolean;
  };
}

export function createEmptyRuntimeCapabilities(): RuntimeCapabilities {
  return {
    prompt: { image: false, audio: false, embeddedContext: false },
    mcp: { stdio: false, http: false, sse: false, acp: false },
    session: {
      load: false,
      list: false,
      delete: false,
      additionalDirectories: false,
      fork: false,
      resume: false,
      close: false,
    },
    extensions: { fsNotify: false, hooksCanDeny: false },
  };
}

export interface RuntimeSnapshot {
  phase: RuntimePhase;
  permissionMode: PermissionModePreference | null;
  /** Normalized non-secret endpoint used by the current or latest connection attempt. */
  xaiApiBaseUrl: string | null;
  /** True only while the active Grok process received an explicit API key. */
  xaiApiKeyConfigured: boolean;
  mcpConfigured: boolean;
  /** Count reported by Grok without exposing any native MCP configuration. */
  reportedMcpServerCount: number;
  /** True when not every reported MCP entry was inspected, so the count is a lower bound. */
  reportedMcpServerCountTruncated: boolean;
  workspacePath: string | null;
  executablePath: string | null;
  grokVersion: string | null;
  protocolVersion: number | string | null;
  currentModelId: string | null;
  availableModels: ModelInfo[];
  authMethods: AuthMethodInfo[];
  capabilities: RuntimeCapabilities;
  sessionExecutions: SessionExecutionSnapshot[];
  message: string | null;
}

export interface SessionModeOption {
  id: string;
  name: string;
  description?: string;
}

export interface SessionConfigValue {
  value: string;
  name: string;
  description?: string | null;
}

export interface SessionConfigOption {
  id: string;
  name: string;
  type: "select" | "boolean";
  currentValue: string | boolean;
  readOnly: boolean;
  description?: string | null;
  category?: string | null;
  options?: SessionConfigValue[];
}

export interface AvailableCommand {
  name: string;
  description: string;
  inputHint?: string | null;
}

export interface SessionReadyPayload {
  sessionId: string;
  workspacePath: string;
  title: string;
  currentModeId: string | null;
  availableModes: SessionModeOption[];
  configOptions: SessionConfigOption[];
  availableCommands: AvailableCommand[];
  loaded: boolean;
}

export interface PromptRequest {
  sessionId: string;
  text: string;
  /** Canonical workspace-local attachments sent through ACP file or image blocks. */
  contextPaths?: string[];
}

export type PermissionOptionKind =
  | "allow_once"
  | "allow_always"
  | "reject_once"
  | "reject_always";

const PERMISSION_OPTION_KINDS = new Set<PermissionOptionKind>([
  "allow_once",
  "allow_always",
  "reject_once",
  "reject_always",
]);

export function isPermissionOptionKind(value: unknown): value is PermissionOptionKind {
  return typeof value === "string" && PERMISSION_OPTION_KINDS.has(value as PermissionOptionKind);
}

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: PermissionOptionKind;
}

export interface PermissionRequestPayload {
  requestId: string;
  sessionId: string;
  title: string;
  toolCall: Record<string, unknown>;
  options: PermissionOption[];
  expiresAt: string;
}

export interface PermissionResponsePayload {
  requestId: string;
  optionId: string | null;
}

export interface TerminalStartRequest {
  workspacePath: string;
  executablePath?: string;
  cols: number;
  rows: number;
}

export interface TerminalResizeRequest {
  cols: number;
  rows: number;
}

export type TurnOutcome =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "failed"
  | "cancelled";

export type DesktopEvent =
  | { type: "runtime"; snapshot: RuntimeSnapshot }
  | { type: "session-ready"; payload: SessionReadyPayload }
  | {
      type: "session-update";
      sessionId: string;
      update: Record<string, unknown>;
      receivedAt: string;
    }
  | {
      type: "turn-started";
      sessionId: string;
      turnId: string;
      receivedAt: string;
    }
  | {
      type: "turn-complete";
      sessionId: string;
      turnId: string;
      outcome: Exclude<TurnOutcome, "failed">;
      stopReason: string;
      receivedAt: string;
    }
  | {
      type: "turn-failed";
      sessionId: string;
      turnId: string;
      message: string;
      receivedAt: string;
    }
  | { type: "permission-request"; payload: PermissionRequestPayload }
  | { type: "permission-resolved"; requestId: string }
  | { type: "terminal-data"; data: string }
  | { type: "terminal-exit"; exitCode: number | null }
  | { type: "notice"; level: "info" | "warning" | "error"; message: string };

export interface DesktopEventEnvelope {
  sequence: number;
  event: DesktopEvent;
}

export interface RuntimeSyncPayload {
  runtime: RuntimeSnapshot;
  sessions: SessionReadyPayload[];
  pendingPermissions: PermissionRequestPayload[];
  replay: DesktopEventEnvelope[];
  latestSequence: number;
  replayTruncated: boolean;
}

export interface ConnectResult {
  snapshot: RuntimeSnapshot;
  xaiApiBaseUrlPersisted: boolean;
  xaiApiKeyPersisted: boolean;
  xaiCredential: XaiCredentialStatus;
  permissionModePersisted: boolean;
}

export interface DesktopApi {
  bootstrap(): Promise<BootstrapPayload>;
  syncRuntime(afterSequence?: number): Promise<RuntimeSyncPayload>;
  chooseWorkspace(): Promise<string | null>;
  chooseContextFiles(workspacePath: string): Promise<ContextFileReference[]>;
  resolveDroppedFiles(
    workspacePath: string,
    filePaths: string[],
  ): Promise<ContextFileReference[]>;
  getPathForDroppedFile(file: unknown): string;
  chooseExecutable(): Promise<GrokInstallation | null>;
  chooseMcpExecutable(): Promise<string | null>;
  discoverModels(request: DesktopDiscoverModelsRequest): Promise<DiscoverModelsResult>;
  setXaiApiBaseUrl(xaiApiBaseUrl: string | null): Promise<string | null>;
  setPermissionMode(mode: PermissionModePreference): Promise<PermissionModePreference>;
  setThemePreference(theme: ThemePreference): Promise<ThemePreference>;
  clearStoredXaiApiKey(): Promise<XaiCredentialStatus>;
  connect(request: DesktopConnectRequest): Promise<ConnectResult>;
  disconnect(): Promise<void>;
  createSession(title?: string): Promise<SessionReadyPayload>;
  loadSession(sessionId: string): Promise<SessionReadyPayload>;
  /** Removes only desktop-owned recent metadata; it never deletes the Grok session. */
  removeRecentSession(sessionId: string): Promise<StoredSession[]>;
  prompt(request: PromptRequest): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  setSessionMode(sessionId: string, modeId: string): Promise<void>;
  setSessionConfig(
    sessionId: string,
    configId: string,
    value: string | boolean,
  ): Promise<void>;
  resolvePermission(response: PermissionResponsePayload): Promise<void>;
  startTerminal(request: TerminalStartRequest): Promise<void>;
  writeTerminal(data: string): Promise<void>;
  resizeTerminal(request: TerminalResizeRequest): Promise<void>;
  stopTerminal(): Promise<void>;
  openInChrome(url: string): Promise<void>;
  onEvent(listener: (envelope: DesktopEventEnvelope) => void): () => void;
}
