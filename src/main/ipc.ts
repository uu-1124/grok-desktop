import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import {
  app,
  dialog,
  ipcMain,
  type BrowserWindow,
  type IpcMainInvokeEvent,
} from "electron";
import { z, type ZodType } from "zod";

import type {
  BootstrapPayload,
  ConnectResult,
  ConnectRequest,
  ContextFileReference,
  GrokInstallation,
  PermissionResponsePayload,
  PermissionModePreference,
  PromptRequest,
  RuntimeSyncPayload,
  SessionReadyPayload,
  StoredSession,
  TerminalResizeRequest,
  TerminalStartRequest,
} from "../shared/contracts.js";
import { MAX_PROMPT_CONTEXT_FILES } from "../shared/contracts.js";
import {
  normalizeXaiApiBaseUrl,
  normalizeXaiApiKey,
} from "../shared/xai-connection.js";
import { normalizeMcpServers } from "../shared/mcp-config.js";
import { openHttpsInChrome } from "./chrome.js";
import type { DesktopEventBus } from "./desktop-event-bus.js";
import { discoverGrok, inspectGrokExecutable, pathsEqual } from "./grok-discovery.js";
import { requireMcpExecutablePath, type GrokRuntime } from "./grok-runtime.js";
import type { SettingsStore } from "./settings-store.js";
import type { TerminalManager } from "./terminal-manager.js";
import {
  preparePromptContextFiles,
  resolveWorkspaceContextFiles,
} from "./workspace-files.js";

export const IPC_CHANNELS = {
  bootstrap: "grok-desktop:bootstrap",
  syncRuntime: "grok-desktop:sync-runtime",
  chooseWorkspace: "grok-desktop:choose-workspace",
  chooseContextFiles: "grok-desktop:choose-context-files",
  chooseExecutable: "grok-desktop:choose-executable",
  chooseMcpExecutable: "grok-desktop:choose-mcp-executable",
  setXaiApiBaseUrl: "grok-desktop:set-xai-api-base-url",
  setPermissionMode: "grok-desktop:set-permission-mode",
  connect: "grok-desktop:connect",
  disconnect: "grok-desktop:disconnect",
  createSession: "grok-desktop:create-session",
  loadSession: "grok-desktop:load-session",
  removeRecentSession: "grok-desktop:remove-recent-session",
  prompt: "grok-desktop:prompt",
  cancel: "grok-desktop:cancel",
  setSessionMode: "grok-desktop:set-session-mode",
  setSessionConfig: "grok-desktop:set-session-config",
  resolvePermission: "grok-desktop:resolve-permission",
  startTerminal: "grok-desktop:start-terminal",
  writeTerminal: "grok-desktop:write-terminal",
  resizeTerminal: "grok-desktop:resize-terminal",
  stopTerminal: "grok-desktop:stop-terminal",
  openInChrome: "grok-desktop:open-in-chrome",
  event: "grok-desktop:event",
} as const;

const MAX_PATH_LENGTH = 32_767;
const MAX_PROMPT_LENGTH = 1_000_000;
const MAX_TERMINAL_WRITE_LENGTH = 1_000_000;

const nonEmptyText = (maximum: number) => z.string().trim().min(1).max(maximum);
const pathSchema = z.string()
  .max(MAX_PATH_LENGTH)
  .refine((value) => value.trim().length > 0 && !value.includes("\0"));
export { pathSchema };
export const identifierSchema = nonEmptyText(1_024);
export const permissionModeSchema = z.enum(["default", "auto", "always_approve"]);
const xaiApiBaseUrlSchema = z.union([z.string(), z.null()]).transform((value, context) => {
  try {
    return normalizeXaiApiBaseUrl(value) ?? null;
  } catch {
    context.addIssue({ code: "custom", message: "Invalid xAI API base URL." });
    return z.NEVER;
  }
});
const xaiApiKeySchema = z.string().transform((value, context) => {
  try {
    return normalizeXaiApiKey(value) as string;
  } catch {
    context.addIssue({ code: "custom", message: "Invalid xAI API key." });
    return z.NEVER;
  }
});
const mcpServersSchema = z.unknown().transform((value, context) => {
  try {
    return normalizeMcpServers(value);
  } catch {
    context.addIssue({ code: "custom", message: "Invalid MCP server configuration." });
    return z.NEVER;
  }
});

const connectSchema = z.strictObject({
  workspacePath: pathSchema,
  executablePath: pathSchema.optional(),
  modelId: identifierSchema.optional(),
  reasoningEffort: identifierSchema.optional(),
  permissionMode: permissionModeSchema.optional(),
  alwaysApprove: z.boolean().optional(),
  xaiApiBaseUrl: xaiApiBaseUrlSchema.optional(),
  xaiApiKey: xaiApiKeySchema.optional(),
  mcpServers: mcpServersSchema.optional(),
  allowStdioMcpExecution: z.literal(true).optional(),
});
const promptSchema = z.strictObject({
  sessionId: identifierSchema,
  text: z.string().min(1).max(MAX_PROMPT_LENGTH),
  contextPaths: z.array(pathSchema).max(MAX_PROMPT_CONTEXT_FILES).optional(),
});
const permissionResponseSchema = z.strictObject({
  requestId: identifierSchema,
  optionId: identifierSchema.nullable(),
});
const terminalStartSchema = z.strictObject({
  workspacePath: pathSchema,
  executablePath: pathSchema.optional(),
  cols: z.number().int().min(20).max(1_000),
  rows: z.number().int().min(5).max(1_000),
});
const terminalResizeSchema = z.strictObject({
  cols: z.number().int().min(20).max(1_000),
  rows: z.number().int().min(5).max(1_000),
});
const titleSchema = nonEmptyText(200).optional();
const terminalDataSchema = z.string().max(MAX_TERMINAL_WRITE_LENGTH);
const urlSchema = z.string().min(1).max(2_048);

interface IpcDependencies {
  eventBus: DesktopEventBus;
  window: BrowserWindow;
  runtime: GrokRuntime;
  settings: SettingsStore;
  terminal: TerminalManager;
}

export function registerIpcHandlers({
  eventBus,
  window,
  runtime,
  settings,
  terminal,
}: IpcDependencies): () => void {
  const registeredChannels: string[] = [];
  let discoveredExecutablePath: string | null = null;

  const registerNoPayload = <Result>(
    channel: string,
    handler: () => Result | Promise<Result>,
  ): void => {
    register(channel, async (event) => {
      assertTrustedSender(event, window);
      return handler();
    });
  };

  const registerValidated = <Payload, Result>(
    channel: string,
    schema: ZodType<Payload>,
    handler: (payload: Payload) => Result | Promise<Result>,
  ): void => {
    register(channel, async (event, rawPayload) => {
      assertTrustedSender(event, window);
      const result = schema.safeParse(rawPayload);
      if (!result.success) {
        throw new Error("请求参数无效。");
      }
      return handler(result.data);
    });
  };

  const register = (
    channel: string,
    handler: (event: IpcMainInvokeEvent, payload?: unknown) => unknown,
  ): void => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, handler);
    registeredChannels.push(channel);
  };

  const resolveTrustedInstallation = async (
    requestedPath?: string,
  ): Promise<GrokInstallation & { executablePath: string }> => {
    const snapshot = settings.getSnapshot();
    const trustedPaths = [snapshot.grokExecutablePath, discoveredExecutablePath].filter(
      (value): value is string => Boolean(value),
    );

    if (
      requestedPath &&
      !trustedPaths.some((trustedPath) => pathsEqual(trustedPath, requestedPath))
    ) {
      throw new Error("Grok 路径尚未经过桌面端选择或验证。");
    }

    const installation = requestedPath
      ? await inspectGrokExecutable(requestedPath)
      : await discoverGrok(snapshot.grokExecutablePath ?? discoveredExecutablePath);

    if (!installation.found || !installation.executablePath) {
      throw new Error(installation.error ?? "未找到 Grok 可执行文件。");
    }

    discoveredExecutablePath = installation.executablePath;
    return { ...installation, executablePath: installation.executablePath };
  };

  registerNoPayload(IPC_CHANNELS.bootstrap, async (): Promise<BootstrapPayload> => {
    const snapshot = settings.getSnapshot();
    const installation = await discoverGrok(snapshot.grokExecutablePath);
    if (installation.found && installation.executablePath) {
      discoveredExecutablePath = installation.executablePath;
    }

    return {
      installation,
      settings: snapshot,
      platform: process.platform,
      appVersion: app.getVersion(),
    };
  });

  registerValidated<number | undefined, RuntimeSyncPayload>(
    IPC_CHANNELS.syncRuntime,
    z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    (afterSequence) => {
      const replay = eventBus.replay(afterSequence ?? 0);
      return {
        runtime: runtime.getSnapshot(),
        sessions: runtime.getSessions(),
        pendingPermissions: runtime.getPendingPermissions(),
        replay: replay.events,
        latestSequence: replay.latestSequence,
        replayTruncated: replay.replayTruncated,
      };
    },
  );

  registerNoPayload(IPC_CHANNELS.chooseWorkspace, async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog(window, {
      title: "选择 Grok 工作目录",
      defaultPath: settings.getSnapshot().lastWorkspacePath ?? undefined,
      properties: ["openDirectory", "createDirectory"],
    });
    const selected = result.filePaths[0];
    if (result.canceled || !selected) {
      return null;
    }
    return requireDirectory(selected);
  });

  registerValidated<string, ContextFileReference[]>(
    IPC_CHANNELS.chooseContextFiles,
    pathSchema,
    async (requestedWorkspacePath) => {
      const workspacePath = await requireDirectory(requestedWorkspacePath);
      const connectedWorkspacePath = runtime.getSnapshot().workspacePath;
      if (
        !connectedWorkspacePath ||
        !pathsEqual(connectedWorkspacePath, workspacePath)
      ) {
        throw new Error("只能为当前连接的 Grok 工作区选择上下文文件。");
      }
      const result = await dialog.showOpenDialog(window, {
        title: "选择要引用的工作区文件",
        buttonLabel: "引用文件",
        defaultPath: workspacePath,
        properties: ["openFile", "multiSelections"],
      });
      if (result.canceled || result.filePaths.length === 0) {
        return [];
      }
      return resolveWorkspaceContextFiles(workspacePath, result.filePaths);
    },
  );

  registerNoPayload(
    IPC_CHANNELS.chooseExecutable,
    async (): Promise<GrokInstallation | null> => {
      const result = await dialog.showOpenDialog(window, {
        title: "选择 grok.exe",
        defaultPath: settings.getSnapshot().grokExecutablePath ?? undefined,
        filters: process.platform === "win32"
          ? [{ name: "Grok executable", extensions: ["exe"] }]
          : undefined,
        properties: ["openFile"],
      });
      const selected = result.filePaths[0];
      if (result.canceled || !selected) {
        return null;
      }

      const installation = await inspectGrokExecutable(selected);
      if (installation.found && installation.executablePath) {
        discoveredExecutablePath = installation.executablePath;
        await persistNonCritical(
          settings.setGrokExecutablePath(installation.executablePath),
        );
      }
      return installation;
    },
  );

  registerNoPayload(
    IPC_CHANNELS.chooseMcpExecutable,
    async (): Promise<string | null> => {
      const result = await dialog.showOpenDialog(window, {
        title: "选择 MCP stdio 可执行文件",
        buttonLabel: "选择程序",
        filters: process.platform === "win32"
          ? [{ name: "Executable", extensions: ["exe"] }]
          : undefined,
        properties: ["openFile"],
      });
      const selected = result.filePaths[0];
      if (result.canceled || !selected) {
        return null;
      }
      return requireMcpExecutablePath(selected);
    },
  );

  registerValidated<string | null, string | null>(
    IPC_CHANNELS.setXaiApiBaseUrl,
    xaiApiBaseUrlSchema,
    async (xaiApiBaseUrl) => {
      await settings.setXaiApiBaseUrl(xaiApiBaseUrl);
      return xaiApiBaseUrl;
    },
  );

  registerValidated<PermissionModePreference, PermissionModePreference>(
    IPC_CHANNELS.setPermissionMode,
    permissionModeSchema,
    async (permissionMode) => {
      await settings.setPermissionMode(permissionMode);
      return permissionMode;
    },
  );

  registerValidated<ConnectRequest, ConnectResult>(
    IPC_CHANNELS.connect,
    connectSchema,
    async (request) => {
      if (terminal.active) {
        throw new Error("请先关闭原始终端，再连接结构化 Grok 会话。");
      }
      const workspacePath = await requireDirectory(request.workspacePath);
      const installation = await resolveTrustedInstallation(request.executablePath);
      const storedXaiApiBaseUrl = settings.getSnapshot().xaiApiBaseUrl;
      const storedPermissionMode = settings.getSnapshot().permissionMode;
      const xaiApiBaseUrl = normalizeXaiApiBaseUrl(
        request.xaiApiBaseUrl === undefined
          ? storedXaiApiBaseUrl
          : request.xaiApiBaseUrl,
      ) ?? null;
      const mcpServers = request.mcpServers
        ? await Promise.all(request.mcpServers.map(async (server) => server.type === "stdio"
          ? { ...server, command: await requireMcpExecutablePath(server.command) }
          : server))
        : undefined;
      const normalizedRequest: ConnectRequest = {
        ...request,
        workspacePath,
        executablePath: installation.executablePath,
        permissionMode: request.permissionMode
          ?? (request.alwaysApprove === undefined
            ? storedPermissionMode
            : request.alwaysApprove ? "always_approve" : "default"),
        xaiApiBaseUrl,
        ...(mcpServers ? { mcpServers } : {}),
      };

      if (normalizedRequest.mcpServers?.some((server) => server.type === "stdio")) {
        if (normalizedRequest.allowStdioMcpExecution !== true) {
          throw new Error("启动本地 MCP 程序前需要明确确认。");
        }
        const confirmation = await dialog.showMessageBox(window, {
          type: "warning",
          title: "运行本地 MCP 程序",
          message: "允许 Grok 启动此工作区配置的本地 MCP 程序吗？",
          detail: "这些程序拥有当前 Windows 用户的文件、网络和进程权限，且不受 Grok 权限弹窗或 OS 沙箱约束。仅在你信任可执行文件与参数时继续。",
          buttons: ["取消", "允许并连接"],
          cancelId: 0,
          defaultId: 0,
          noLink: true,
        });
        if (confirmation.response !== 1) {
          throw new Error("已取消启动本地 MCP 程序。");
        }
      }

      const snapshot = await runtime.connect(normalizedRequest);
      let xaiApiBaseUrlPersisted = true;
      try {
        await settings.setXaiApiBaseUrl(xaiApiBaseUrl);
      } catch {
        xaiApiBaseUrlPersisted = false;
        console.warn("Grok Desktop connected, but could not persist the API base URL.");
      }
      let permissionModePersisted = true;
      try {
        await settings.setPermissionMode(normalizedRequest.permissionMode ?? "default");
      } catch {
        permissionModePersisted = false;
        console.warn("Grok Desktop connected, but could not persist the permission mode.");
      }
      await persistNonCritical(
        Promise.all([
          settings.setGrokExecutablePath(installation.executablePath),
          settings.recordWorkspace(workspacePath),
        ]).then(() => undefined),
      );
      return { snapshot, xaiApiBaseUrlPersisted, permissionModePersisted };
    },
  );

  registerNoPayload(IPC_CHANNELS.disconnect, () => runtime.disconnect());

  registerValidated<string | undefined, SessionReadyPayload>(
    IPC_CHANNELS.createSession,
    titleSchema,
    async (title) => {
      const session = await runtime.createSession(title);
      await persistNonCritical(recordSession(settings, session));
      return session;
    },
  );

  registerValidated<string, SessionReadyPayload>(
    IPC_CHANNELS.loadSession,
    identifierSchema,
    async (sessionId) => {
      const storedTitle = settings
        .getSnapshot()
        .recentSessions.find((entry) => entry.sessionId === sessionId)?.title;
      const session = await runtime.loadSession(sessionId, storedTitle);
      await persistNonCritical(recordSession(settings, session));
      return session;
    },
  );

  registerValidated<string, StoredSession[]>(
    IPC_CHANNELS.removeRecentSession,
    identifierSchema,
    async (sessionId) => {
      if (runtime.getSessions().some((session) => session.sessionId === sessionId)) {
        throw new Error("当前进程已加载该任务，无法只移除桌面端最近记录。");
      }
      return settings.removeSession(sessionId);
    },
  );

  registerValidated<PromptRequest, void>(
    IPC_CHANNELS.prompt,
    promptSchema,
    async (request) => {
      if (!request.contextPaths?.length) {
        return runtime.prompt(request);
      }
      const workspacePath = runtime.getSnapshot().workspacePath;
      if (!workspacePath) {
        throw new Error("Grok 工作区已断开，无法引用文件。");
      }
      const references = await resolveWorkspaceContextFiles(
        workspacePath,
        request.contextPaths,
      );
      const preparedContextFiles = await preparePromptContextFiles(
        references,
        runtime.getSnapshot().capabilities.prompt.embeddedContext,
      );
      const currentWorkspacePath = runtime.getSnapshot().workspacePath;
      if (!currentWorkspacePath || !pathsEqual(currentWorkspacePath, workspacePath)) {
        throw new Error("验证上下文文件期间 Grok 工作区发生了变化。");
      }
      return runtime.prompt({
        ...request,
        contextPaths: references.map((reference) => reference.path),
      }, preparedContextFiles);
    },
  );
  registerValidated<string, void>(IPC_CHANNELS.cancel, identifierSchema, (sessionId) =>
    runtime.cancel(sessionId),
  );
  registerValidated<{ sessionId: string; modeId: string }, void>(
    IPC_CHANNELS.setSessionMode,
    z.strictObject({ sessionId: identifierSchema, modeId: identifierSchema }),
    ({ sessionId, modeId }) => runtime.setSessionMode(sessionId, modeId),
  );
  registerValidated<{ sessionId: string; configId: string; value: string | boolean }, void>(
    IPC_CHANNELS.setSessionConfig,
    z.strictObject({
      sessionId: identifierSchema,
      configId: identifierSchema,
      value: z.union([z.string().max(16_384), z.boolean()]),
    }),
    ({ sessionId, configId, value }) =>
      runtime.setSessionConfig(sessionId, configId, value),
  );
  registerValidated<PermissionResponsePayload, void>(
    IPC_CHANNELS.resolvePermission,
    permissionResponseSchema,
    (response) => runtime.resolvePermission(response),
  );

  registerValidated<TerminalStartRequest, void>(
    IPC_CHANNELS.startTerminal,
    terminalStartSchema,
    async (request) => {
      if (runtime.active) {
        throw new Error("原始终端与 ACP 会话不能同时运行，请先断开当前连接。");
      }
      const workspacePath = await requireDirectory(request.workspacePath);
      const installation = await resolveTrustedInstallation(request.executablePath);
      terminal.start({
        ...request,
        workspacePath,
        executablePath: installation.executablePath,
      });
    },
  );
  registerValidated<string, void>(IPC_CHANNELS.writeTerminal, terminalDataSchema, (data) => {
    terminal.write(data);
  });
  registerValidated<TerminalResizeRequest, void>(
    IPC_CHANNELS.resizeTerminal,
    terminalResizeSchema,
    ({ cols, rows }) => terminal.resize(cols, rows),
  );
  registerNoPayload(IPC_CHANNELS.stopTerminal, () => terminal.stop());
  registerValidated<string, void>(IPC_CHANNELS.openInChrome, urlSchema, (url) =>
    openHttpsInChrome(url),
  );

  return () => {
    for (const channel of registeredChannels) {
      ipcMain.removeHandler(channel);
    }
  };
}

function assertTrustedSender(event: IpcMainInvokeEvent, window: BrowserWindow): void {
  if (
    window.isDestroyed() ||
    event.sender.id !== window.webContents.id ||
    event.senderFrame !== window.webContents.mainFrame
  ) {
    throw new Error("拒绝来自非主窗口的 IPC 请求。");
  }
}

async function requireDirectory(directoryPath: string): Promise<string> {
  if (!path.isAbsolute(directoryPath) || directoryPath.includes("\0")) {
    throw new Error("工作目录无效。");
  }

  try {
    const canonicalPath = await realpath(directoryPath);
    const directory = await stat(canonicalPath);
    if (!directory.isDirectory()) {
      throw new Error("所选工作路径不是目录。");
    }
    return canonicalPath;
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "所选工作路径不是目录。") {
      throw error;
    }
    throw new Error("工作目录不存在或不可访问。");
  }
}

async function recordSession(
  settings: SettingsStore,
  session: SessionReadyPayload,
): Promise<void> {
  const previous = settings
    .getSnapshot()
    .recentSessions.find((entry) => entry.sessionId === session.sessionId);
  const now = new Date().toISOString();
  const storedSession: StoredSession = {
    sessionId: session.sessionId,
    workspacePath: session.workspacePath,
    title: session.title.trim() || "未命名会话",
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };
  await settings.recordSession(storedSession);
}

async function persistNonCritical(write: Promise<void>): Promise<void> {
  try {
    await write;
  } catch {
    // Recent paths and titles are convenience metadata. A persistence failure
    // must not turn a successful Grok operation into a false runtime failure.
    console.warn("Grok Desktop could not persist local convenience metadata.");
  }
}
