import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
} from "react";
import type {
  BootstrapPayload,
  AvailableCommand,
  ContextFileReference,
  DesktopEvent,
  DesktopEventEnvelope,
  GrokInstallation,
  McpHttpHeader,
  McpHttpServerConfig,
  McpServerConfig,
  McpStdioEnvironmentVariable,
  McpStdioServerConfig,
  McpTransport,
  ModelInfo,
  PermissionOptionKind,
  PermissionModePreference,
  PermissionRequestPayload,
  RuntimePhase,
  RuntimeSnapshot,
  ReasoningEffortInfo,
  SessionExecutionPhase,
  SessionExecutionSnapshot,
  SessionConfigOption,
  SessionReadyPayload,
  StoredSession,
  ThemePreference,
  TurnOutcome,
  XaiCredentialStatus,
} from "../shared/contracts";
import {
  createEmptyRuntimeCapabilities,
  MAX_PROMPT_CONTEXT_FILES,
} from "../shared/contracts";
import {
  MAX_MCP_HEADERS_PER_SERVER,
  MAX_MCP_HEADER_NAME_LENGTH,
  MAX_MCP_HEADER_VALUE_LENGTH,
  MAX_MCP_SERVERS,
  MAX_MCP_SERVER_NAME_LENGTH,
  MAX_MCP_SERVER_URL_LENGTH,
  MAX_MCP_STDIO_SERVERS,
  MAX_MCP_STDIO_ARGUMENT_LENGTH,
  MAX_MCP_STDIO_ARGUMENTS_PER_SERVER,
  MAX_MCP_STDIO_COMMAND_LENGTH,
  MAX_MCP_STDIO_ENV_NAME_LENGTH,
  MAX_MCP_STDIO_ENV_PER_SERVER,
  MAX_MCP_STDIO_ENV_VALUE_LENGTH,
  assertMcpTransportsAdvertised,
  getMcpServerCredentialScope,
  normalizeMcpServers,
  transitionMcpHeadersForUrl,
  validateMcpServers,
} from "../shared/mcp-config";
import {
  MAX_XAI_API_BASE_URL_LENGTH,
  MAX_XAI_API_KEY_LENGTH,
  getXaiApiCredentialScope as getSharedXaiApiCredentialScope,
  isLoopbackXaiApiBaseUrl,
  normalizeXaiApiBaseUrl as normalizeSharedXaiApiBaseUrl,
  normalizeXaiApiKey as normalizeSharedXaiApiKey,
} from "../shared/xai-connection";
import {
  addLocalPrompt,
  applySessionReady,
  applySessionUpdate,
  basename,
  createDiffHunks,
  createEmptySessionView,
  createLineDiff,
  failTurn,
  finishTurn,
  formatClock,
  formatRelativeDate,
  lineStatsFromDiff,
  projectVisibleActivity,
  redactPermissionText,
  summarizePermissionDetails,
  summarizeRaw,
  type ActivityRecord,
  type ChangeRecord,
  type DiffHunk,
  type PlanEntryView,
  type SessionViewState,
  type ToolTimelineItem,
} from "./lib/acp";
import {
  composerDraftKey,
  moveComposerDraft,
  readComposerDraft,
  writeComposerDraft,
  type ComposerDrafts,
} from "./lib/composer-drafts";
import {
  readWorkspaceMcpServers,
  workspaceMcpConfigKey,
  writeWorkspaceMcpServers,
  type WorkspaceMcpConfigs,
} from "./lib/workspace-mcp-config";
import { acquireWorkspaceConnectionLock } from "./lib/workspace-connection-lock";
import {
  nextExecutionDisclosureOpen,
  projectTimelinePresentation,
  summarizeExecutionGroup,
  type ConversationMessageTimelineItem,
  type ExecutionGroupEntry,
  type ExecutionTimelineItem,
} from "./lib/timeline-presentation";
import {
  AlertIcon,
  ArrowUpIcon,
  ChatIcon,
  CheckIcon,
  ChevronIcon,
  CloseIcon,
  CopyIcon,
  FileIcon,
  FolderIcon,
  ImageIcon,
  MenuIcon,
  MoreIcon,
  PanelIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  SparkIcon,
  StopIcon,
  TerminalIcon,
} from "./components/Icons";
import { RichText } from "./components/RichText";
import { copyTextToClipboard } from "./lib/clipboard";
import { userFacingErrorMessage } from "./lib/user-facing-error";
import { resolveTheme } from "./lib/theme";

const TerminalPanel = lazy(async () => {
  const module = await import("./components/TerminalPanel");
  return { default: module.TerminalPanel };
});

type InspectorTab = "activity" | "plan" | "changes" | "config";
type MainView = "conversation" | "terminal";
type NoticeLevel = "info" | "warning" | "error";
type ModelDiscoveryPhase = "idle" | "loading" | "ready" | "error";

interface NoticeState {
  id: number;
  level: NoticeLevel;
  message: string;
}

const EMPTY_RUNTIME: RuntimeSnapshot = {
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

const EMPTY_XAI_CREDENTIAL_STATUS: XaiCredentialStatus = {
  available: false,
  scope: null,
  secureStorageAvailable: false,
};

const STATUS_COPY: Record<RuntimePhase, string> = {
  offline: "未连接",
  connecting: "正在连接",
  ready: "就绪",
  working: "Grok 正在执行",
  waiting_permission: "等待授权",
  stopping: "正在停止",
  error: "连接异常",
};

const QUICK_PROMPTS = ["梳理这个项目的结构与入口", "检查当前项目中值得关注的问题", "说明如何运行和验证这个项目"];
const MCP_TRANSPORTS = ["http", "sse", "stdio"] as const;
let mcpEditorSequence = 0;

interface ConnectionSettingsDraft {
  baseUrl: string;
  apiKey: string;
  models: ModelInfo[];
  enabledModelIds: string[];
  permissionMode: PermissionModePreference;
  modelId: string | null;
  reasoningEffort: string | null;
  mcpServers: McpServerConfig[];
  allowStdioMcpExecution: boolean;
}

interface EditableMcpServerFields {
  editorId: string;
}

type EditableMcpHttpServer = McpHttpServerConfig & EditableMcpServerFields & {
  headerScope: string | undefined;
  headersClearedForEndpointChange: boolean;
  showHeaderValues: boolean;
};

type EditableMcpStdioServer = McpStdioServerConfig & EditableMcpServerFields & {
  showEnvironmentValues: boolean;
};

type EditableMcpServer = EditableMcpHttpServer | EditableMcpStdioServer;

type ContextFileDrafts = Record<string, ContextFileReference[]>;

export function mergeContextFiles(
  current: readonly ContextFileReference[],
  incoming: readonly ContextFileReference[],
): ContextFileReference[] {
  const next = [...current];
  const seen = new Set(current.map((file) => file.path.toLocaleLowerCase("en-US")));
  for (const file of incoming) {
    const key = file.path.toLocaleLowerCase("en-US");
    if (!seen.has(key)) {
      seen.add(key);
      next.push(file);
    }
    if (next.length >= MAX_PROMPT_CONTEXT_FILES) {
      break;
    }
  }
  return next;
}

export function formatAttachmentSize(size: number): string {
  if (!Number.isFinite(size) || size < 0) return "大小未知";
  if (size < 1_024) return `${Math.round(size)} B`;
  if (size < 1_024 * 1_024) return `${(size / 1_024).toFixed(size < 10 * 1_024 ? 1 : 0)} KiB`;
  return `${(size / 1_024 / 1_024).toFixed(size < 10 * 1_024 * 1_024 ? 1 : 0)} MiB`;
}

function createEditableMcpServers(
  servers: readonly McpServerConfig[],
): EditableMcpServer[] {
  return servers.map((server) => server.type === "stdio"
    ? {
        ...server,
        editorId: `mcp-server-${++mcpEditorSequence}`,
        args: [...server.args],
        env: server.env.map((variable) => ({ ...variable })),
        showEnvironmentValues: false,
      }
    : {
        ...server,
        editorId: `mcp-server-${++mcpEditorSequence}`,
        headers: server.headers.map((header) => ({ ...header })),
        headerScope: getMcpServerCredentialScope(server.url),
        headersClearedForEndpointChange: false,
        showHeaderValues: false,
      });
}

function createEmptyEditableMcpServer(type: McpTransport): EditableMcpServer {
  const fields = {
    editorId: `mcp-server-${++mcpEditorSequence}`,
    name: "",
  };
  return type === "stdio"
    ? {
        ...fields,
        type,
        command: "",
        args: [],
        env: [],
        showEnvironmentValues: false,
      }
    : {
        ...fields,
        type,
        url: "",
        headers: [],
        headerScope: undefined,
        headersClearedForEndpointChange: false,
        showHeaderValues: false,
      };
}

export function mcpSettingsError(
  servers: readonly McpServerConfig[],
  runtime: RuntimeSnapshot,
  capabilitiesAuthoritative = runtime.protocolVersion !== null,
): string | null {
  const validationError = validateMcpServers(servers);
  if (validationError) return validationError;
  // Before initialize there is no authoritative capability set; Main gates
  // the request immediately after Grok advertises its real capabilities.
  if (!capabilitiesAuthoritative) return null;
  try {
    assertMcpTransportsAdvertised(servers, runtime.capabilities.mcp);
    return null;
  } catch (error) {
    return userFacingErrorMessage(error, "当前 Grok 不支持所选 MCP 传输。");
  }
}

export function runtimeCapabilitiesApplyToExecutable(
  runtime: RuntimeSnapshot,
  executablePath: string | null | undefined,
): boolean {
  return runtime.protocolVersion !== null &&
    runtime.executablePath !== null &&
    executablePath !== null &&
    executablePath !== undefined &&
    runtime.executablePath === executablePath;
}

export function hasUnrestoredMcpConfiguration(
  runtime: RuntimeSnapshot,
  mcpServers: readonly McpServerConfig[],
  workspacePath: string | null,
  platform: string,
): boolean {
  if (!runtime.mcpConfigured || mcpServers.length > 0) return false;
  const runtimeKey = workspaceMcpConfigKey(runtime.workspacePath, platform);
  const workspaceKey = workspaceMcpConfigKey(workspacePath, platform);
  return runtimeKey !== null && runtimeKey === workspaceKey;
}

export function runtimeMcpStatusAppliesToWorkspace(
  runtime: RuntimeSnapshot,
  workspacePath: string | null,
  platform: string,
): boolean {
  const runtimeKey = workspaceMcpConfigKey(runtime.workspacePath, platform);
  const workspaceKey = workspaceMcpConfigKey(workspacePath, platform);
  return runtimeKey !== null && runtimeKey === workspaceKey;
}

export function reportedMcpServerCountLabel(runtime: RuntimeSnapshot): string {
  return runtime.reportedMcpServerCountTruncated
    ? `至少 ${runtime.reportedMcpServerCount}`
    : String(runtime.reportedMcpServerCount);
}

export function reasoningEffortsForModel(
  models: readonly ModelInfo[],
  modelId: string | null,
): ReasoningEffortInfo[] {
  if (!modelId) return [];
  const model = models.find((candidate) => candidate.id === modelId);
  return model?.reasoningEfforts?.map((effort) => ({ ...effort })) ?? [];
}

export function preferredReasoningEffort(
  models: readonly ModelInfo[],
  modelId: string | null,
): string {
  const model = models.find((candidate) => candidate.id === modelId);
  const advertised = model?.reasoningEfforts ?? [];
  if (model?.reasoningEffort && advertised.some((effort) => effort.id === model.reasoningEffort)) {
    return model.reasoningEffort;
  }
  return advertised.find((effort) => effort.isDefault)?.id ?? "";
}

function normalizeXaiApiBaseUrl(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError("API Base URL 必填");
  const baseUrl = normalizeSharedXaiApiBaseUrl(normalized);
  if (typeof baseUrl !== "string") throw new TypeError("API Base URL 必填");
  return baseUrl;
}

function normalizeXaiApiKey(value: string): string {
  return value.trim();
}

export function validateXaiApiBaseUrl(value: string): string | null {
  const normalized = value.trim();
  if (!normalized) return "API Base URL 必填";
  if (value.length > MAX_XAI_API_BASE_URL_LENGTH) {
    return `URL 不能超过 ${MAX_XAI_API_BASE_URL_LENGTH.toLocaleString()} 个字符`;
  }
  if (normalized.includes("\0")) return "URL 包含无效控制字符";

  try {
    normalizeSharedXaiApiBaseUrl(normalized);
    return null;
  } catch {
    // Continue below to turn the shared security policy into actionable copy.
  }

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return "请输入完整 URL，例如 https://provider.example/v1";
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return "仅支持 HTTPS；本机开发服务可使用 HTTP";
  }
  if (parsed.username || parsed.password) {
    return "URL 不能包含用户名或密码";
  }
  if (parsed.search || parsed.hash || /[?#]/.test(normalized)) {
    return "URL 不能包含查询参数或片段";
  }

  if (parsed.protocol === "http:") {
    return "远程 API 必须使用 HTTPS；HTTP 仅允许 localhost、127.0.0.1 或 ::1";
  }
  return "URL 不符合安全连接规则";
}

export function validateXaiConnectionPair(
  baseUrl: string,
  apiKey: string,
  storedCredentialAvailable = false,
): string | null {
  const baseUrlError = validateXaiApiBaseUrl(baseUrl);
  if (baseUrlError) return baseUrlError;
  if (!apiKey.trim()) return storedCredentialAvailable ? null : "API Key 必填";
  try {
    normalizeSharedXaiApiKey(apiKey);
    return null;
  } catch {
    return `API Key 必须是有效的非空字符串，且不能超过 ${MAX_XAI_API_KEY_LENGTH.toLocaleString()} 个字符`;
  }
}

export function xaiApiBaseUrlAdvisory(value: string): string | null {
  const normalized = value.trim();
  if (!normalized) return null;

  try {
    const baseUrl = normalizeSharedXaiApiBaseUrl(normalized);
    if (typeof baseUrl !== "string" || isLoopbackXaiApiBaseUrl(baseUrl)) return null;
    if (new URL(baseUrl).pathname !== "/") return null;
  } catch {
    return null;
  }

  return "当前地址没有 API 路径；检测时会优先尝试同 Origin 的 /v1，再验证原地址。";
}

export function grokConnectionErrorMessage(error: unknown, baseUrl: string): string {
  const raw = error instanceof Error && error.message
    ? error.message
    : typeof error === "string"
      ? error
      : "";
  const advisory = xaiApiBaseUrlAdvisory(baseUrl);
  const returnedNonJson = /(?:kind:\s*Decode|expected value[^\n]*line:\s*1[^\n]*column:\s*1)/iu.test(raw);

  if (/Unable to resolve the supplied API base URL through Grok ACP/iu.test(raw)) {
    return "无法连接 Grok：已自动尝试用户地址及同 Origin 的兼容 API 路径，但均未通过 ACP 初始化。请核对 URL 与 API Key，并确认服务商支持 OpenAI/xAI 兼容接口。";
  }
  if (returnedNonJson) {
    return advisory
      ? `无法连接 Grok：API Base URL 返回了网页或其他非 JSON 响应。${advisory}`
      : "无法连接 Grok：API Base URL 返回了网页或其他非 JSON 响应。请确认地址指向兼容 API 根路径（通常以 /v1 结尾）。";
  }
  if (/Timed out while initializing the Grok ACP connection/iu.test(raw) && advisory) {
    return `无法连接 Grok：ACP 初始化超时。${advisory}`;
  }
  return userFacingErrorMessage(error, "项目连接失败");
}

export function redactSensitiveText(value: string, secret: string): string {
  const normalizedSecret = normalizeXaiApiKey(secret);
  if (!normalizedSecret) return value;
  let redacted = value.split(normalizedSecret).join("[已隐藏]");
  try {
    const encodedSecret = encodeURIComponent(normalizedSecret);
    if (encodedSecret !== normalizedSecret) redacted = redacted.split(encodedSecret).join("[已隐藏]");
  } catch {
    // Invalid surrogate pairs are not expected in API keys; exact matching above still applies.
  }
  return redacted;
}

export function sessionLoadFailureDetail(error: unknown, secret: string): string {
  const fallback = "Grok 没有返回可用的历史任务。";
  const normalized = redactSensitiveText(userFacingErrorMessage(error, fallback), secret);
  const userFacing = /^Unable to load the Grok session:\s*Path not found\.?$/i.test(normalized)
    ? "Grok 找不到这条历史任务。它可能已不在当前 Grok 会话目录中。"
    : normalized.replace(/^Unable to load the Grok session:\s*/i, "Grok 无法加载此任务：");
  return userFacing.length > 180 ? `${userFacing.slice(0, 179)}…` : userFacing;
}

export function xaiApiKeyHelpText(baseUrl: string): string {
  void baseUrl;
  return "URL 与 Key 必须同时提供。连接成功后，Key 使用系统安全凭据存储加密，仅绑定当前用户与 API Origin，不写入普通设置。";
}

export function getXaiApiCredentialScope(
  baseUrl: string,
): string | null | undefined {
  if (!baseUrl.trim()) return null;
  try {
    return getSharedXaiApiCredentialScope(baseUrl);
  } catch {
    return undefined;
  }
}

export function canUseStoredXaiCredential(
  baseUrl: string,
  credential: XaiCredentialStatus,
): boolean {
  return credential.available &&
    credential.scope !== null &&
    credential.scope === getXaiApiCredentialScope(baseUrl);
}

export function transitionXaiApiKeyForBaseUrl(
  apiKey: string,
  apiKeyScope: string | null | undefined,
  nextBaseUrl: string,
): {
  apiKey: string;
  apiKeyScope: string | null | undefined;
  cleared: boolean;
} {
  const nextScope = getXaiApiCredentialScope(nextBaseUrl);
  if (nextScope === undefined) {
    // Preserve the last valid scope while the user is midway through editing.
    return { apiKey, apiKeyScope, cleared: false };
  }
  if (apiKey && apiKeyScope !== nextScope) {
    return { apiKey: "", apiKeyScope: nextScope, cleared: true };
  }
  return { apiKey, apiKeyScope: nextScope, cleared: false };
}

export function requiresXaiApiKeyReentry(
  runtime: Pick<RuntimeSnapshot, "xaiApiBaseUrl" | "xaiApiKeyConfigured">,
  requestedBaseUrl: string,
  requestedApiKey: string,
  storedCredentialAvailable = false,
): boolean {
  if (!runtime.xaiApiKeyConfigured || requestedApiKey.trim() || storedCredentialAvailable) {
    return false;
  }
  return getXaiApiCredentialScope(runtime.xaiApiBaseUrl ?? "") ===
    getXaiApiCredentialScope(requestedBaseUrl);
}

export function deriveLocalSessionTitle(
  prompt: string,
  contextFileNames: readonly string[] = [],
): string {
  const contextName = contextFileNames.find((name) => name.trim().length > 0)?.trim();
  const contextUnits = contextName ? Array.from(contextName) : [];
  const normalized = prompt.replace(/\s+/gu, " ").trim();
  const category = [
    { label: "修复问题", pattern: /(?:\b(?:fix|debug|repair|bug)\b|修复|调试|排查|故障)/iu },
    { label: "重构代码", pattern: /(?:\brefactor\b|重构|整理代码)/iu },
    { label: "实现功能", pattern: /(?:\b(?:implement|build|create|add)\b|实现|开发|构建|新增|添加)/iu },
    { label: "验证项目", pattern: /(?:\b(?:test|verify|validate)\b|测试|验证)/iu },
    { label: "分析项目", pattern: /(?:\b(?:review|audit|inspect|analyze|scan|check)\b|分析|审查|检查|扫描|梳理)/iu },
    { label: "说明项目", pattern: /(?:\b(?:explain|describe|how)\b|解释|说明|如何)/iu },
  ].find((candidate) => candidate.pattern.test(normalized))?.label;
  const base = category ?? (contextUnits.length > 0 ? "处理文件" : "Grok 任务");
  if (contextUnits.length === 0) return base;
  const fileLabel = `${contextUnits.slice(0, 44).join("")}${contextUnits.length > 44 ? "…" : ""}`;
  return `${base} · ${fileLabel}`;
}

export interface XaiConnectionBadge {
  label: string;
  title: string;
  keyConfigured: boolean;
}

export function getXaiConnectionBadge(
  runtime: Pick<RuntimeSnapshot, "xaiApiBaseUrl" | "xaiApiKeyConfigured">,
): XaiConnectionBadge | null {
  const endpoint = runtime.xaiApiBaseUrl?.trim() || null;
  if (!endpoint) return null;

  let endpointLabel: string;
  try {
    endpointLabel = new URL(endpoint).host;
  } catch {
    endpointLabel = "自定义 API";
  }
  const keyNotice = runtime.xaiApiKeyConfigured
    ? "；API Key 已配置且不会进入普通设置或日志"
    : "";
  return {
    label: `${endpointLabel}${runtime.xaiApiKeyConfigured ? " · Key 已配置" : ""}`,
    title: `当前 API：${endpoint}${keyNotice}。点击打开连接设置。`,
    keyConfigured: runtime.xaiApiKeyConfigured,
  };
}

export function resolveRequestedPermissionMode(
  committed: PermissionModePreference,
  settings?: Pick<ConnectionSettingsDraft, "permissionMode">,
  override?: PermissionModePreference,
): PermissionModePreference {
  return override ?? settings?.permissionMode ?? committed;
}

const PERMISSION_MODE_OPTIONS: ReadonlyArray<{
  id: PermissionModePreference;
  label: string;
  description: string;
  recommended?: boolean;
  danger?: boolean;
}> = [
  { id: "default", label: "逐项授权", description: "敏感工具每次执行前都由你确认。" },
  {
    id: "auto",
    label: "自动",
    description: "Grok 自动批准安全操作，危险操作仍会询问。",
    recommended: true,
  },
  {
    id: "always_approve",
    label: "完全授权",
    description: "跳过所有工具确认，仅用于完全信任的工作区。",
    danger: true,
  },
];

const THEME_OPTIONS: ReadonlyArray<{
  id: ThemePreference;
  label: string;
  description: string;
}> = [
  { id: "system", label: "跟随系统", description: "随 Windows 外观实时切换。" },
  { id: "light", label: "浅色", description: "始终使用明亮工作台。" },
  { id: "dark", label: "深色", description: "始终使用低亮度工作台。" },
];

export function permissionModeLabel(mode: PermissionModePreference): string {
  return PERMISSION_MODE_OPTIONS.find((option) => option.id === mode)?.label ?? "逐项授权";
}

export function moveCommandSelection(
  currentIndex: number,
  direction: -1 | 1,
  commandCount: number,
): number {
  if (commandCount <= 0) return 0;
  return (currentIndex + direction + commandCount) % commandCount;
}

export function filterAvailableCommands(
  commands: readonly AvailableCommand[],
  query: string,
): AvailableCommand[] {
  const normalizedQuery = query.trim().toLocaleLowerCase("en-US");
  return commands.filter((command) =>
    !normalizedQuery || command.name.toLocaleLowerCase("en-US").includes(normalizedQuery)
  );
}

const SESSION_SEARCH_THRESHOLD = 8;

export function filterStoredSessions(
  sessions: readonly StoredSession[],
  query: string,
): StoredSession[] {
  const terms = query
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (terms.length === 0) return [...sessions];
  return sessions.filter((session) => {
    const title = session.title.normalize("NFKC").toLocaleLowerCase();
    return terms.every((term) => title.includes(term));
  });
}

export function shouldOfferSessionSearch(sessionCount: number, searchOpen: boolean): boolean {
  return searchOpen || sessionCount >= SESSION_SEARCH_THRESHOLD;
}

export function sessionSearchEscapeAction(query: string): "clear" | "close" {
  return query.length > 0 ? "clear" : "close";
}

export type SessionRecencyGroupId = "today" | "yesterday" | "previous-7" | "previous-30" | "earlier";

export interface SessionRecencyGroup {
  id: SessionRecencyGroupId;
  label: string;
  sessions: StoredSession[];
}

export function shouldGroupStoredSessions(sessionCount: number): boolean {
  return sessionCount >= SESSION_SEARCH_THRESHOLD;
}

export function groupStoredSessionsByRecency(
  sessions: readonly StoredSession[],
  now = new Date(),
): SessionRecencyGroup[] {
  const year = now.getFullYear();
  const month = now.getMonth();
  const day = now.getDate();
  const startToday = new Date(year, month, day).getTime();
  const startYesterday = new Date(year, month, day - 1).getTime();
  const startPrevious7 = new Date(year, month, day - 7).getTime();
  const startPrevious30 = new Date(year, month, day - 30).getTime();
  const groups: SessionRecencyGroup[] = [
    { id: "today", label: "今天", sessions: [] },
    { id: "yesterday", label: "昨天", sessions: [] },
    { id: "previous-7", label: "过去 7 天", sessions: [] },
    { id: "previous-30", label: "过去 30 天", sessions: [] },
    { id: "earlier", label: "更早", sessions: [] },
  ];

  for (const session of sessions) {
    const timestamp = new Date(session.updatedAt).getTime();
    const groupIndex = !Number.isFinite(timestamp) || timestamp < startPrevious30
      ? 4
      : timestamp < startPrevious7
        ? 3
        : timestamp < startYesterday
          ? 2
          : timestamp < startToday
            ? 1
            : 0;
    groups[groupIndex]!.sessions.push(session);
  }

  return groups.filter((group) => group.sessions.length > 0);
}

export function canRemoveStoredSession(
  sessionId: string,
  activeSessionId: string | null,
  mountedSessionIds: readonly string[],
  execution: SessionExecutionSnapshot | undefined,
): boolean {
  return sessionId !== activeSessionId &&
    !mountedSessionIds.includes(sessionId) &&
    !isBusyExecution(execution);
}

export function isTimelineNearBottom(
  metrics: Pick<HTMLElement, "clientHeight" | "scrollHeight" | "scrollTop">,
  threshold = 96,
): boolean {
  const distance = metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight;
  return distance <= threshold;
}

export function resolveWorkspaceContext(
  runtimeWorkspacePath: string | null | undefined,
  currentWorkspacePath: string | null | undefined,
  rememberedWorkspacePath: string | null | undefined,
): string | null {
  return runtimeWorkspacePath ?? currentWorkspacePath ?? rememberedWorkspacePath ?? null;
}

export function resolvePermissionSource(
  sessionId: string,
  activeSession: Pick<SessionReadyPayload, "sessionId" | "title" | "workspacePath"> | null,
  sessions: readonly StoredSession[],
  fallbackWorkspacePath: string | null,
): { taskTitle: string; workspacePath: string | null; isCurrentTask: boolean } {
  const activeMatch = activeSession?.sessionId === sessionId ? activeSession : null;
  const storedMatch = sessions.find((session) => session.sessionId === sessionId) ?? null;
  return {
    taskTitle: activeMatch?.title || storedMatch?.title || `未知任务 · ${sessionId.slice(0, 8)}`,
    workspacePath: activeMatch?.workspacePath || storedMatch?.workspacePath || fallbackWorkspacePath,
    isCurrentTask: Boolean(activeMatch),
  };
}

function mergeSession(sessions: StoredSession[], ready: SessionReadyPayload): StoredSession[] {
  const now = new Date().toISOString();
  const index = sessions.findIndex((session) => session.sessionId === ready.sessionId);
  const previous = index >= 0 ? sessions[index] : null;
  const session: StoredSession = {
    sessionId: ready.sessionId,
    workspacePath: ready.workspacePath,
    title: ready.title || previous?.title || "新任务",
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };
  if (index < 0) return [session, ...sessions];
  const next = [...sessions];
  next[index] = session;
  return next;
}

function executionForSession(
  runtime: RuntimeSnapshot,
  sessionId: string | null | undefined,
): SessionExecutionSnapshot | undefined {
  return sessionId
    ? runtime.sessionExecutions.find((execution) => execution.sessionId === sessionId)
    : undefined;
}

function isBusyExecution(execution: SessionExecutionSnapshot | undefined): boolean {
  return execution?.phase === "working" ||
    execution?.phase === "waiting_permission" ||
    execution?.phase === "cancelling";
}

export function settingsDisconnectControl(
  runtime: RuntimeSnapshot,
  taskBusy: boolean,
): {
  disabled: boolean;
  force: boolean;
  label: string;
  title: string | undefined;
} {
  const force = taskBusy && runtime.sessionExecutions.some(
    (execution) => execution.phase === "cancelling",
  );
  const disabled = runtime.phase === "offline" || (taskBusy && !force);
  return {
    disabled,
    force,
    label: force ? "强制停止 Grok" : "断开当前连接",
    title: force
      ? "立即结束本地 Grok 进程；当前任务会标记为失败"
      : taskBusy
        ? "请先停止正在运行的任务"
        : undefined,
  };
}

function executionLabel(execution: SessionExecutionSnapshot | undefined): string | null {
  if (!execution) return null;
  if (execution.phase === "working") return "正在执行";
  if (execution.phase === "waiting_permission") return "等待授权";
  if (execution.phase === "cancelling") return "正在停止";
  if (execution.phase === "failed") return "执行失败";
  if (execution.phase === "cancelled") return "已取消";
  if (execution.phase === "end_turn") return "已完成";
  if (execution.phase === "max_tokens") return "达到输出上限";
  if (execution.phase === "max_turn_requests") return "达到轮次上限";
  if (execution.phase === "refusal") return "Grok 已拒绝";
  return null;
}

export function turnOutcomePresentation(outcome: TurnOutcome): {
  label: string;
  detail: string | null;
  tone: "success" | "warning" | "error" | "cancelled";
} {
  switch (outcome) {
    case "end_turn":
      return { label: "任务已完成", detail: null, tone: "success" };
    case "max_tokens":
      return { label: "回复达到 Token 上限", detail: "回复可能不完整，可以让 Grok 从中断处继续。", tone: "warning" };
    case "max_turn_requests":
      return { label: "任务达到最大轮次", detail: "任务尚未正常收尾，请检查结果后决定是否继续。", tone: "warning" };
    case "refusal":
      return { label: "Grok 拒绝执行这项请求", detail: "该轮没有成功完成，也不会作为正常结果继续推进。", tone: "error" };
    case "failed":
      return { label: "任务执行失败", detail: null, tone: "error" };
    case "cancelled":
      return { label: "任务已取消", detail: null, tone: "cancelled" };
  }
}

function executionTurnOutcome(execution: SessionExecutionSnapshot | undefined): TurnOutcome | null {
  if (!execution) return null;
  switch (execution.phase) {
    case "end_turn":
    case "max_tokens":
    case "max_turn_requests":
    case "refusal":
    case "failed":
    case "cancelled":
      return execution.phase;
    default:
      return null;
  }
}

export function getUsageLabel(view: SessionViewState | undefined): string | null {
  const usage = view?.usage;
  if (!usage) return null;
  if (usage.contextUsed !== null && usage.contextSize !== null) {
    const percentage = Math.min(100, Math.max(0, Math.round((usage.contextUsed / Math.max(usage.contextSize, 1)) * 100)));
    return `${percentage}% 上下文`;
  }
  if (usage.totalTokens !== null) return `${usage.totalTokens.toLocaleString()} tokens`;
  if (usage.contextUsed !== null) return `${usage.contextUsed.toLocaleString()} tokens 已用`;
  if (usage.contextSize !== null) return `${usage.contextSize.toLocaleString()} tokens 窗口`;
  if (usage.inputTokens !== null || usage.outputTokens !== null || usage.thoughtTokens !== null || usage.cost !== null) {
    return "用量";
  }
  return null;
}

export interface UsageDetailRow {
  id: "context" | "input" | "output" | "thought" | "total" | "cost";
  label: string;
  value: string;
}

function formatUsageCost(amount: number): string {
  return amount.toLocaleString(undefined, { maximumSignificantDigits: 15 });
}

export function getUsageDetailRows(view: SessionViewState | undefined): UsageDetailRow[] {
  const usage = view?.usage;
  if (!usage) return [];
  const rows: UsageDetailRow[] = [];
  if (usage.contextUsed !== null && usage.contextSize !== null) {
    rows.push({
      id: "context",
      label: "上下文",
      value: `${usage.contextUsed.toLocaleString()} / ${usage.contextSize.toLocaleString()} tokens`,
    });
  } else if (usage.contextUsed !== null) {
    rows.push({ id: "context", label: "上下文已用", value: `${usage.contextUsed.toLocaleString()} tokens` });
  } else if (usage.contextSize !== null) {
    rows.push({ id: "context", label: "上下文窗口", value: `${usage.contextSize.toLocaleString()} tokens` });
  }
  if (usage.inputTokens !== null) {
    rows.push({ id: "input", label: "输入", value: `${usage.inputTokens.toLocaleString()} tokens` });
  }
  if (usage.outputTokens !== null) {
    rows.push({ id: "output", label: "输出", value: `${usage.outputTokens.toLocaleString()} tokens` });
  }
  if (usage.thoughtTokens !== null) {
    rows.push({ id: "thought", label: "思考", value: `${usage.thoughtTokens.toLocaleString()} tokens` });
  }
  if (usage.totalTokens !== null) {
    rows.push({ id: "total", label: "总计", value: `${usage.totalTokens.toLocaleString()} tokens` });
  }
  if (usage.cost !== null) {
    rows.push({ id: "cost", label: "累计费用", value: `${formatUsageCost(usage.cost.amount)} ${usage.cost.currency}` });
  }
  return rows;
}

export interface ConversationAlertView {
  id: "runtime-error" | "base-url-persistence" | "replay-truncated";
  tone: "error" | "warning";
  title: string;
  detail: string;
  reconnect: boolean;
  settings: boolean;
  dismissible: boolean;
}

export function getConversationAlerts(
  runtime: RuntimeSnapshot,
  replayHistoryIncomplete: boolean,
  baseUrlPersistenceFailed: boolean,
): ConversationAlertView[] {
  const alerts: ConversationAlertView[] = [];
  if (runtime.phase === "error") {
    alerts.push({
      id: "runtime-error",
      tone: "error",
      title: "Grok 连接已中断",
      detail: runtime.message?.trim() || "当前运行时不可用。重新连接不会自动重发上一条请求。",
      reconnect: true,
      settings: true,
      dismissible: false,
    });
  }
  if (baseUrlPersistenceFailed) {
    alerts.push({
      id: "base-url-persistence",
      tone: "warning",
      title: "API Base URL 尚未保存",
      detail: "当前配置未写入磁盘；应用重启后需要重新设置此端点。",
      reconnect: false,
      settings: true,
      dismissible: false,
    });
  }
  if (replayHistoryIncomplete) {
    alerts.push({
      id: "replay-truncated",
      tone: "warning",
      title: "较早记录未完整恢复",
      detail: "当前运行状态已同步，但这次界面恢复窗口不包含全部历史事件。",
      reconnect: false,
      settings: false,
      dismissible: true,
    });
  }
  return alerts;
}

export function getActiveModelLabel(
  view: SessionViewState | undefined,
  runtime: RuntimeSnapshot,
): string {
  const sessionModel = view?.configOptions.find(
    (option) => option.type === "select" && option.category === "model",
  );
  if (sessionModel?.type === "select" && typeof sessionModel.currentValue === "string") {
    const selected = sessionModel.options?.find(
      (option) => option.value === sessionModel.currentValue,
    );
    return selected?.name || sessionModel.currentValue;
  }
  const runtimeModel = runtime.availableModels.find(
    (model) => model.id === runtime.currentModelId,
  );
  return runtimeModel?.name || runtime.currentModelId || runtime.grokVersion || "Grok";
}

export function selectEnabledModels(
  models: readonly ModelInfo[],
  enabledModelIds: readonly string[],
): ModelInfo[] {
  const enabled = new Set(enabledModelIds);
  const seen = new Set<string>();
  return models.filter((model) => {
    if (!enabled.has(model.id) || seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  }).map((model) => ({
    ...model,
    ...(model.reasoningEfforts
      ? { reasoningEfforts: model.reasoningEfforts.map((effort) => ({ ...effort })) }
      : {}),
  }));
}

export function reconnectModelSelection(
  runtime: Pick<RuntimeSnapshot, "currentModelId">,
  enabledModels: readonly ModelInfo[],
  preference: { modelId: string | null; reasoningEffort: string | null },
): { modelId?: string; reasoningEffort?: string } {
  const requestedModelId = runtime.currentModelId ?? preference.modelId;
  const model = enabledModels.find((candidate) => candidate.id === requestedModelId);
  if (!model) return {};

  const reasoningEffort = preference.modelId === model.id
    ? preference.reasoningEffort
    : null;
  return {
    modelId: model.id,
    ...(reasoningEffort && model.reasoningEfforts?.some((effort) => effort.id === reasoningEffort)
      ? { reasoningEffort }
      : {}),
  };
}

export interface ActiveModelControl {
  currentModelId: string;
  configId: string | null;
  strategy: "session" | "reconnect";
  models: ModelInfo[];
}

export function getActiveModelControl(
  view: SessionViewState | undefined,
  runtime: RuntimeSnapshot,
  enabledModels: readonly ModelInfo[],
): ActiveModelControl | null {
  const sessionModel = view?.configOptions.find(
    (option) => option.type === "select" && option.category === "model",
  );
  const allowedIds = new Set(enabledModels.map((model) => model.id));
  const sessionModels = sessionModel?.type === "select"
    ? (sessionModel.options ?? []).flatMap((option): ModelInfo[] =>
        allowedIds.size === 0 || allowedIds.has(option.value)
          ? [{ id: option.value, name: option.name, ...(option.description ? { description: option.description } : {}) }]
          : [])
    : [];
  const models = sessionModels.length > 0
    ? sessionModels
    : enabledModels.map((model) => ({ ...model }));
  if (models.length === 0) return null;

  const requestedCurrent = sessionModel?.type === "select" && typeof sessionModel.currentValue === "string"
    ? sessionModel.currentValue
    : runtime.currentModelId;
  const currentModelId = requestedCurrent && models.some((model) => model.id === requestedCurrent)
    ? requestedCurrent
    : models[0]!.id;
  const sessionEditable = Boolean(sessionModel && !sessionModel.readOnly);
  return {
    currentModelId,
    configId: sessionEditable ? sessionModel!.id : null,
    strategy: sessionEditable ? "session" : "reconnect",
    models,
  };
}

function useDialogFocus<T extends HTMLElement>(identity: string) {
  const dialogRef = useRef<T>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog) return;
    const selector = 'button:not(:disabled), select:not(:disabled), textarea:not(:disabled), input:not(:disabled), summary, [tabindex]:not([tabindex="-1"])';
    const getFocusable = () => Array.from(dialog.querySelectorAll<HTMLElement>(selector)).filter((element) => !element.hasAttribute("hidden"));
    dialog.focus({ preventScroll: true });
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const focusable = getFocusable();
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (document.activeElement === dialog) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    dialog.addEventListener("keydown", trap);
    return () => {
      dialog.removeEventListener("keydown", trap);
      previous?.focus();
    };
  }, [identity]);
  return dialogRef;
}

function App() {
  const [bootstrap, setBootstrap] = useState<BootstrapPayload | null>(null);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0);
  const [installation, setInstallation] = useState<GrokInstallation | null>(null);
  const [runtime, setRuntime] = useState<RuntimeSnapshot>(EMPTY_RUNTIME);
  const [selectedWorkspacePath, setSelectedWorkspacePath] = useState<string | null>(null);
  const [sessions, setSessions] = useState<StoredSession[]>([]);
  const [sessionLoadFailures, setSessionLoadFailures] = useState<Record<string, string>>({});
  const [activeSession, setActiveSession] = useState<SessionReadyPayload | null>(null);
  const [mountedSessions, setMountedSessions] = useState<Record<string, SessionReadyPayload>>({});
  const [views, setViews] = useState<Record<string, SessionViewState>>({});
  const [permissions, setPermissions] = useState<PermissionRequestPayload[]>([]);
  const [permissionBusy, setPermissionBusy] = useState(false);
  const [notices, setNotices] = useState<NoticeState[]>([]);
  const [composerDrafts, setComposerDrafts] = useState<ComposerDrafts>({});
  const [contextFileDrafts, setContextFileDrafts] = useState<ContextFileDrafts>({});
  const [submittingSessionId, setSubmittingSessionId] = useState<string | null>(null);
  const [sessionBusy, setSessionBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTargetWorkspacePath, setSettingsTargetWorkspacePath] = useState<string | null | undefined>(undefined);
  const [workspaceConnectionBusy, setWorkspaceConnectionBusy] = useState(false);
  const [permissionMode, setPermissionMode] = useState<PermissionModePreference>("default");
  const [themePreference, setThemePreference] = useState<ThemePreference>("system");
  const [xaiApiBaseUrl, setXaiApiBaseUrl] = useState("");
  const [xaiApiKey, setXaiApiKey] = useState("");
  const [storedXaiCredential, setStoredXaiCredential] = useState<XaiCredentialStatus>(
    EMPTY_XAI_CREDENTIAL_STATUS,
  );
  const [modelCatalog, setModelCatalog] = useState<ModelInfo[]>([]);
  const [enabledModelIds, setEnabledModelIds] = useState<string[]>([]);
  const [reconnectModelPreference, setReconnectModelPreference] = useState<{
    modelId: string | null;
    reasoningEffort: string | null;
  }>({ modelId: null, reasoningEffort: null });
  const [workspaceMcpConfigs, setWorkspaceMcpConfigs] = useState<WorkspaceMcpConfigs>({});
  const [configBusyId, setConfigBusyId] = useState<string | null>(null);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("activity");
  const [mainView, setMainView] = useState<MainView>("conversation");
  const [terminalSwitchBusy, setTerminalSwitchBusy] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [timelineFollowPaused, setTimelineFollowPaused] = useState(false);
  const [replayHistoryIncomplete, setReplayHistoryIncomplete] = useState(false);
  const [baseUrlPersistenceFailed, setBaseUrlPersistenceFailed] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [dropBusy, setDropBusy] = useState(false);
  const timelineRef = useRef<HTMLDivElement>(null);
  const timelineFollowingRef = useRef(true);
  const noticeCounter = useRef(0);
  const xaiApiKeyRef = useRef("");
  const workspaceConnectionBusyRef = useRef(false);
  const lastEventSequence = useRef(0);
  const pendingEventEnvelopes = useRef<DesktopEventEnvelope[]>([]);
  const rendererSynchronized = useRef(false);
  const railToggleRef = useRef<HTMLButtonElement>(null);
  const inspectorToggleRef = useRef<HTMLButtonElement>(null);
  const dragDepth = useRef(0);

  useEffect(() => {
    const colorScheme = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const resolved = resolveTheme(themePreference, colorScheme.matches);
      document.documentElement.dataset.theme = resolved;
      document.documentElement.style.colorScheme = resolved;
    };
    apply();
    colorScheme.addEventListener("change", apply);
    return () => colorScheme.removeEventListener("change", apply);
  }, [themePreference]);

  const pushNotice = useCallback((message: string, level: NoticeLevel = "info") => {
    const id = ++noticeCounter.current;
    const visibleMessage = redactSensitiveText(
      userFacingErrorMessage(message, message),
      xaiApiKeyRef.current,
    );
    setNotices((items) => [...items.slice(-3), { id, message: visibleMessage, level }]);
    window.setTimeout(() => setNotices((items) => items.filter((item) => item.id !== id)), 5000);
  }, []);

  const clearSessionLoadFailure = useCallback((sessionId: string) => {
    setSessionLoadFailures((current) => {
      if (!(sessionId in current)) return current;
      const next = { ...current };
      delete next[sessionId];
      return next;
    });
  }, []);

  const openSettings = useCallback((targetWorkspacePath: string | null) => {
    setSettingsTargetWorkspacePath(targetWorkspacePath);
    setSettingsOpen(true);
  }, []);

  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    setSettingsTargetWorkspacePath(undefined);
  }, []);

  const closeInspector = useCallback((restoreFocus = false) => {
    setInspectorOpen(false);
    if (restoreFocus) {
      window.requestAnimationFrame(() => inspectorToggleRef.current?.focus());
    }
  }, []);

  const closeRail = useCallback((restoreFocus = false) => {
    setRailOpen(false);
    if (restoreFocus) {
      window.requestAnimationFrame(() => railToggleRef.current?.focus());
    }
  }, []);

  const acquireWorkspaceConnection = useCallback((): (() => void) | null => {
    return acquireWorkspaceConnectionLock(
      workspaceConnectionBusyRef,
      setWorkspaceConnectionBusy,
    );
  }, []);

  const acceptRuntimeSnapshot = useCallback((snapshot: RuntimeSnapshot) => {
    const message = snapshot.message
      ? redactSensitiveText(
          userFacingErrorMessage(snapshot.message, snapshot.message),
          xaiApiKeyRef.current,
        )
      : snapshot.message;
    setRuntime(message === snapshot.message ? snapshot : { ...snapshot, message });
    {
      const models = snapshot.availableModels.map((model) => ({
        ...model,
        ...(model.reasoningEfforts
          ? { reasoningEfforts: model.reasoningEfforts.map((effort) => ({ ...effort })) }
          : {}),
      }));
      setModelCatalog(models);
      setEnabledModelIds((current) => {
        const available = new Set(models.map((model) => model.id));
        const retained = current.filter((modelId) => available.has(modelId));
        return retained.length > 0 ? retained : models.map((model) => model.id);
      });
    }
    if (snapshot.permissionMode) setPermissionMode(snapshot.permissionMode);
    setSelectedWorkspacePath((current) =>
      resolveWorkspaceContext(snapshot.workspacePath, current, null),
    );
  }, []);

  const acceptSession = useCallback((ready: SessionReadyPayload) => {
    clearSessionLoadFailure(ready.sessionId);
    setSelectedWorkspacePath(ready.workspacePath);
    setActiveSession(ready);
    setMountedSessions((current) => ({ ...current, [ready.sessionId]: ready }));
    setSessions((items) => mergeSession(items, ready));
    setViews((current) => ({
      ...current,
      [ready.sessionId]: applySessionReady(
        current[ready.sessionId] ?? createEmptySessionView(),
        ready,
      ),
    }));
    setMainView("conversation");
  }, [clearSessionLoadFailure]);

  const applyDesktopEvent = useCallback((event: DesktopEvent) => {
    if (event.type === "runtime") {
      acceptRuntimeSnapshot(event.snapshot);
      return;
    }
    if (event.type === "session-ready") {
      acceptSession(event.payload);
      return;
    }
    if (event.type === "session-update") {
      setViews((current) => ({
        ...current,
        [event.sessionId]: applySessionUpdate(
          current[event.sessionId] ?? createEmptySessionView(),
          event.update,
          event.receivedAt,
        ),
      }));
      if (
        event.update.sessionUpdate === "session_info_update" &&
        typeof event.update.title === "string" &&
        event.update.title.trim()
      ) {
        const title = event.update.title.trim();
        setActiveSession((current) =>
          current?.sessionId === event.sessionId ? { ...current, title } : current,
        );
        setMountedSessions((current) => {
          const mountedSession = current[event.sessionId];
          return mountedSession
            ? { ...current, [event.sessionId]: { ...mountedSession, title } }
            : current;
        });
        setSessions((current) => current.map((session) =>
          session.sessionId === event.sessionId
            ? { ...session, title, updatedAt: event.receivedAt }
            : session,
        ));
      }
      return;
    }
    if (event.type === "turn-started") {
      setViews((current) => ({
        ...current,
        [event.sessionId]: {
          ...(current[event.sessionId] ?? createEmptySessionView()),
          stopReason: null,
          turnOutcome: null,
          turnError: null,
        },
      }));
      return;
    }
    if (event.type === "turn-complete") {
      setViews((current) => ({
        ...current,
        [event.sessionId]: finishTurn(
          current[event.sessionId] ?? createEmptySessionView(),
          event.stopReason,
          event.outcome,
        ),
      }));
      return;
    }
    if (event.type === "turn-failed") {
      const message = redactSensitiveText(
        userFacingErrorMessage(event.message, "任务执行失败"),
        xaiApiKeyRef.current,
      );
      setViews((current) => ({
        ...current,
        [event.sessionId]: failTurn(
          current[event.sessionId] ?? createEmptySessionView(),
          message,
        ),
      }));
      return;
    }
    if (event.type === "permission-request") {
      setPermissions((current) => [
        ...current.filter((item) => item.requestId !== event.payload.requestId),
        event.payload,
      ]);
      return;
    }
    if (event.type === "permission-resolved") {
      setPermissions((current) =>
        current.filter((item) => item.requestId !== event.requestId),
      );
      return;
    }
    if (event.type === "notice") {
      pushNotice(event.message, event.level);
    }
  }, [acceptRuntimeSnapshot, acceptSession, pushNotice]);

  const applyEventEnvelope = useCallback((envelope: DesktopEventEnvelope) => {
    if (envelope.sequence <= lastEventSequence.current) {
      return;
    }
    lastEventSequence.current = envelope.sequence;
    applyDesktopEvent(envelope.event);
  }, [applyDesktopEvent]);

  useEffect(() => {
    if (!window.grokDesktop) {
      setBootstrapError("桌面桥接未加载。请从 Grok Desktop 启动应用，而不是直接打开网页。");
      return;
    }

    let alive = true;
    rendererSynchronized.current = false;
    pendingEventEnvelopes.current = [];
    const unsubscribe = window.grokDesktop.onEvent((envelope) => {
      if (!alive) return;
      if (!rendererSynchronized.current) {
        pendingEventEnvelopes.current.push(envelope);
        return;
      }
      applyEventEnvelope(envelope);
    });

    const initialize = async () => {
      try {
        const payload = await window.grokDesktop.bootstrap();
        const sync = await window.grokDesktop.syncRuntime(0);
        if (!alive) return;
        setBootstrap(payload);
        setInstallation(payload.installation);
        setStoredXaiCredential(payload.xaiCredential);
        setThemePreference(payload.settings.themePreference);
        setSessions(payload.settings.recentSessions);
        setSessionLoadFailures({});
        const lastWorkspace = payload.settings.lastWorkspacePath;
        setSelectedWorkspacePath(
          resolveWorkspaceContext(sync.runtime.workspacePath, null, lastWorkspace),
        );
        setActiveSession(null);
        setMountedSessions({});
        setViews({});
        setContextFileDrafts({});
        setPermissions([]);
        lastEventSequence.current = 0;
        for (const envelope of [...sync.replay].sort(
          (left, right) => left.sequence - right.sequence,
        )) {
          applyEventEnvelope(envelope);
        }
        acceptRuntimeSnapshot(sync.runtime);
        setPermissions(sync.pendingPermissions);
        setSessions((current) =>
          sync.sessions.reduce(
            (items, session) => mergeSession(items, session),
            current,
          ),
        );
        setViews((current) => {
          const next = { ...current };
          for (const session of sync.sessions) {
            next[session.sessionId] = applySessionReady(
              next[session.sessionId] ?? createEmptySessionView(),
              session,
            );
          }
          return next;
        });
        setMountedSessions(Object.fromEntries(
          sync.sessions.map((session) => [session.sessionId, session]),
        ));
        const preferredSession = sync.sessions.find((session) =>
          isBusyExecution(executionForSession(sync.runtime, session.sessionId)),
        ) ?? sync.sessions.at(-1) ?? null;
        setActiveSession(preferredSession);
        lastEventSequence.current = sync.latestSequence;
        rendererSynchronized.current = true;
        const queued = [...pendingEventEnvelopes.current].sort(
          (left, right) => left.sequence - right.sequence,
        );
        pendingEventEnvelopes.current = [];
        for (const envelope of queued) {
          applyEventEnvelope(envelope);
        }
        setReplayHistoryIncomplete(sync.replayTruncated);
        if (sync.replayTruncated) {
          pushNotice("较早的执行记录超出内存恢复窗口，当前任务状态已同步", "warning");
        }
        const configuredBaseUrl = sync.runtime.phase === "offline"
          ? payload.settings.xaiApiBaseUrl ?? ""
          : sync.runtime.xaiApiBaseUrl ?? "";
        setXaiApiBaseUrl(configuredBaseUrl);
        const configuredPermissionMode = sync.runtime.permissionMode
          ?? payload.settings.permissionMode;
        setPermissionMode(configuredPermissionMode);
        const configuredBaseUrlError = configuredBaseUrl
          ? validateXaiApiBaseUrl(configuredBaseUrl)
          : null;
        if (configuredBaseUrlError) {
          pushNotice(`已保存的 API Base URL 无效：${configuredBaseUrlError}`, "warning");
        } else if (
          sync.runtime.phase === "offline" &&
          payload.installation.found &&
          lastWorkspace
        ) {
          openSettings(lastWorkspace);
          const storedCredentialAvailable = canUseStoredXaiCredential(
            configuredBaseUrl,
            payload.xaiCredential,
          );
          pushNotice(
            configuredBaseUrl
              ? storedCredentialAvailable
                ? "API Base URL 与本机安全保存的 Key 已恢复，可直接获取模型并连接。"
                : "API Base URL 已保留；请输入 API Key，获取模型后连接。"
              : "请输入 API Base URL 和 API Key，获取模型后连接项目。",
            "info",
          );
        }
      } catch (error) {
        if (alive) setBootstrapError(userFacingErrorMessage(error, "桌面端初始化失败"));
      }
    };
    void initialize();
    return () => {
      alive = false;
      rendererSynchronized.current = false;
      unsubscribe();
    };
  }, [
    acceptRuntimeSnapshot,
    acquireWorkspaceConnection,
    applyEventEnvelope,
    bootstrapAttempt,
    openSettings,
    pushNotice,
  ]);

  const currentView = activeSession ? views[activeSession.sessionId] ?? createEmptySessionView() : undefined;
  const activeEnabledModels = selectEnabledModels(modelCatalog, enabledModelIds);
  const workspacePath = selectedWorkspacePath;
  const platform = bootstrap?.platform ?? "win32";
  const settingsWorkspacePath = settingsTargetWorkspacePath === undefined
    ? workspacePath
    : settingsTargetWorkspacePath;
  const settingsMcpServers = readWorkspaceMcpServers(
    workspaceMcpConfigs,
    settingsWorkspacePath,
    platform,
  );
  const activeDraftKey = composerDraftKey(activeSession?.sessionId, workspacePath);
  const composer = readComposerDraft(composerDrafts, activeDraftKey);
  const contextFiles = contextFileDrafts[activeDraftKey] ?? [];
  const setComposer = useCallback((value: string | ((current: string) => string)) => {
    setComposerDrafts((drafts) => {
      const current = readComposerDraft(drafts, activeDraftKey);
      const next = typeof value === "function" ? value(current) : value;
      return writeComposerDraft(drafts, activeDraftKey, next);
    });
  }, [activeDraftKey]);
  const setContextFiles = useCallback((
    value: ContextFileReference[] | ((current: ContextFileReference[]) => ContextFileReference[]),
  ) => {
    setContextFileDrafts((drafts) => {
      const current = drafts[activeDraftKey] ?? [];
      const next = typeof value === "function" ? value(current) : value;
      if (next.length === 0) {
        const updated = { ...drafts };
        delete updated[activeDraftKey];
        return updated;
      }
      return { ...drafts, [activeDraftKey]: next };
    });
  }, [activeDraftKey]);
  const currentExecution = executionForSession(runtime, activeSession?.sessionId);
  const isWorking = isBusyExecution(currentExecution) ||
    submittingSessionId === activeSession?.sessionId ||
    (submittingSessionId === "pending" && !activeSession);
  const anyTaskBusy = runtime.sessionExecutions.some(isBusyExecution) ||
    submittingSessionId !== null;
  const permission = permissions[0] ?? null;
  const permissionSource = permission
    ? resolvePermissionSource(permission.sessionId, activeSession, sessions, runtime.workspacePath ?? workspacePath)
    : null;
  const permissionFrozen = permission
    ? executionForSession(runtime, permission.sessionId)?.phase === "cancelling"
    : false;
  const canUseSession = runtime.phase === "ready" || runtime.phase === "working" || runtime.phase === "waiting_permission";
  const canAcceptDroppedFiles = Boolean(
    workspacePath &&
    canUseSession &&
    mainView === "conversation" &&
    !settingsOpen &&
    !permission &&
    !dropBusy,
  );

  useEffect(() => {
    if (canAcceptDroppedFiles) return;
    dragDepth.current = 0;
    setDropActive(false);
  }, [canAcceptDroppedFiles]);

  const workspaceSessions = useMemo(() => sessions
    .filter((session) => !workspacePath || session.workspacePath === workspacePath)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()), [sessions, workspacePath]);

  const timelineSignature = currentView?.timeline.map((item) => {
    if (item.kind === "message") {
      return `${item.id}:message:${item.text.length}:${item.contextFiles.length}`;
    }
    if (item.kind === "tool") {
      return `${item.id}:tool:${item.receivedAt}:${item.status}:${item.output.length}:${item.locations.length}`;
    }
    return `${item.id}:plan:${item.receivedAt}:${item.entries.map((entry) => entry.status).join(",")}:${item.note?.length ?? 0}`;
  }).join("|");
  const updateTimelineFollowing = useCallback(() => {
    const element = timelineRef.current;
    if (!element) return;
    const following = isTimelineNearBottom(element);
    timelineFollowingRef.current = following;
    setTimelineFollowPaused(!following);
  }, []);
  const scrollTimelineToLatest = useCallback((behavior: ScrollBehavior = "smooth") => {
    timelineFollowingRef.current = true;
    setTimelineFollowPaused(false);
    const element = timelineRef.current;
    if (element) element.scrollTo({ top: element.scrollHeight, behavior });
  }, []);

  useEffect(() => {
    if (mainView !== "conversation") return;
    timelineFollowingRef.current = true;
    setTimelineFollowPaused(false);
    const frame = window.requestAnimationFrame(() => scrollTimelineToLatest("auto"));
    return () => window.cancelAnimationFrame(frame);
  }, [activeSession?.sessionId, mainView, scrollTimelineToLatest]);

  useEffect(() => {
    const element = timelineRef.current;
    if (!element || !timelineFollowingRef.current) return;
    element.scrollTo({ top: element.scrollHeight, behavior: "auto" });
  }, [timelineSignature, isWorking]);

  const connectWorkspace = useCallback(async (
    path: string,
    settings?: ConnectionSettingsDraft,
    permissionModeOverride?: PermissionModePreference,
  ): Promise<RuntimeSnapshot | null> => {
    if (!path || workspaceConnectionBusyRef.current) return null;
    const requestedBaseUrl = settings ? settings.baseUrl : xaiApiBaseUrl;
    const requestedApiKey = normalizeXaiApiKey(settings ? settings.apiKey : xaiApiKey);
    const storedCredentialAvailable = canUseStoredXaiCredential(
      requestedBaseUrl,
      storedXaiCredential,
    );
    const requestedPermissionMode = resolveRequestedPermissionMode(
      permissionMode,
      settings,
      permissionModeOverride,
    );
    const requestedMcpServers = settings
      ? settings.mcpServers
      : readWorkspaceMcpServers(workspaceMcpConfigs, path, platform);
    if (!settings && requestedMcpServers.some((server) => server.type === "stdio")) {
      pushNotice("重新启动本地 MCP 程序前需要再次确认。", "warning");
      openSettings(path);
      return null;
    }
    const connectionError = validateXaiConnectionPair(
      requestedBaseUrl,
      requestedApiKey,
      storedCredentialAvailable,
    );
    if (connectionError) {
      pushNotice(`连接设置无效：${connectionError}`, "warning");
      openSettings(path);
      return null;
    }
    if (requiresXaiApiKeyReentry(
      runtime,
      requestedBaseUrl,
      requestedApiKey,
      storedCredentialAvailable,
    )) {
      pushNotice("当前连接的 API Key 未保存在系统安全凭据库中；重新连接前请在设置中重新输入。", "warning");
      openSettings(path);
      return null;
    }
    const mcpError = mcpSettingsError(
      requestedMcpServers,
      runtime,
      runtimeCapabilitiesApplyToExecutable(runtime, installation?.executablePath),
    );
    if (mcpError) {
      pushNotice(mcpError, "warning");
      openSettings(path);
      return null;
    }
    const normalizedMcpServers = normalizeMcpServers(requestedMcpServers);
    const requestedModel = settings
      ? {
          ...(settings.modelId ? { modelId: settings.modelId } : {}),
          ...(settings.modelId && settings.reasoningEffort
            ? { reasoningEffort: settings.reasoningEffort }
            : {}),
        }
      : reconnectModelSelection(
          runtime,
          selectEnabledModels(modelCatalog, enabledModelIds),
          reconnectModelPreference,
        );
    const releaseConnection = acquireWorkspaceConnection();
    if (!releaseConnection) return null;
    try {
      if (mainView === "terminal") {
        await window.grokDesktop.stopTerminal();
      }
      setMainView("conversation");
      const result = await window.grokDesktop.connect({
        workspacePath: path,
        ...(installation?.executablePath ? { executablePath: installation.executablePath } : {}),
        ...requestedModel,
        permissionMode: requestedPermissionMode,
        xaiApiBaseUrl: normalizeXaiApiBaseUrl(requestedBaseUrl),
        ...(requestedApiKey
          ? { xaiApiKey: requestedApiKey }
          : { useStoredXaiApiKey: true as const }),
        ...(normalizedMcpServers.length > 0 ? { mcpServers: normalizedMcpServers } : {}),
        ...(settings?.allowStdioMcpExecution ? { allowStdioMcpExecution: true as const } : {}),
      });
      const snapshot = result.snapshot;
      const connectedModelId = snapshot.currentModelId ?? requestedModel.modelId ?? null;
      setReconnectModelPreference({
        modelId: connectedModelId,
        reasoningEffort: connectedModelId && connectedModelId === requestedModel.modelId
          ? requestedModel.reasoningEffort ?? null
          : null,
      });
      setActiveSession(null);
      setMountedSessions({});
      const canonicalWorkspacePath = snapshot.workspacePath ?? path;
      setWorkspaceMcpConfigs((configs) => writeWorkspaceMcpServers(
        configs,
        canonicalWorkspacePath,
        normalizedMcpServers,
        platform,
        path,
      ));
      acceptRuntimeSnapshot(snapshot);
      if (snapshot.xaiApiBaseUrl) setXaiApiBaseUrl(snapshot.xaiApiBaseUrl);
      setBaseUrlPersistenceFailed(!result.xaiApiBaseUrlPersisted);
      setStoredXaiCredential(result.xaiCredential);
      if (!result.xaiApiBaseUrlPersisted) {
        pushNotice("已连接，但 API Base URL 无法写入磁盘；重启后需要重新设置。", "warning");
      }
      if (!result.permissionModePersisted) {
        pushNotice("已连接，但权限模式无法写入磁盘；重启后将恢复逐项授权。", "warning");
      }
      if (!result.xaiApiKeyPersisted) {
        pushNotice("已连接，但 API Key 无法写入系统安全凭据库；应用退出后需要重新输入。", "warning");
      }
      setContextFileDrafts({});
      setRailOpen(false);
      return snapshot;
    } catch (error) {
      pushNotice(
        redactSensitiveText(grokConnectionErrorMessage(error, requestedBaseUrl), requestedApiKey),
        "error",
      );
      return null;
    } finally {
      releaseConnection();
    }
  }, [
    acceptRuntimeSnapshot,
    acquireWorkspaceConnection,
    permissionMode,
    installation?.executablePath,
    mainView,
    modelCatalog,
    enabledModelIds,
    openSettings,
    platform,
    pushNotice,
    runtime,
    reconnectModelPreference,
    workspaceMcpConfigs,
    storedXaiCredential,
    xaiApiBaseUrl,
    xaiApiKey,
  ]);

  const changePermissionMode = useCallback(async (nextMode: PermissionModePreference) => {
    if (anyTaskBusy || workspaceConnectionBusyRef.current) return;
    if (nextMode === permissionMode && runtime.permissionMode === nextMode) return;
    if (!workspacePath) {
      try {
        const saved = await window.grokDesktop.setPermissionMode(nextMode);
        setPermissionMode(saved);
        pushNotice(`权限模式已设为${permissionModeLabel(saved)}，将在下次连接时生效`);
      } catch (error) {
        pushNotice(userFacingErrorMessage(error, "权限模式保存失败"), "error");
      }
      return;
    }
    const snapshot = await connectWorkspace(workspacePath, undefined, nextMode);
    if (!snapshot) return;
    setPermissionMode(nextMode);
    pushNotice(`已切换为${permissionModeLabel(nextMode)}`);
  }, [anyTaskBusy, connectWorkspace, permissionMode, pushNotice, runtime.permissionMode, workspacePath]);

  const changeTheme = useCallback(async (nextTheme: ThemePreference): Promise<boolean> => {
    if (nextTheme === themePreference) return true;
    const previousTheme = themePreference;
    setThemePreference(nextTheme);
    try {
      const saved = await window.grokDesktop.setThemePreference(nextTheme);
      setThemePreference(saved);
      return true;
    } catch (error) {
      setThemePreference(previousTheme);
      pushNotice(userFacingErrorMessage(error, "外观设置保存失败"), "error");
      return false;
    }
  }, [pushNotice, themePreference]);

  const toggleTerminal = useCallback(async () => {
    if (!workspacePath || anyTaskBusy || terminalSwitchBusy || workspaceConnectionBusyRef.current) return;
    setTerminalSwitchBusy(true);
    if (mainView === "terminal") {
      try {
        await connectWorkspace(workspacePath);
      } finally {
        setTerminalSwitchBusy(false);
      }
      return;
    }
    const releaseConnection = acquireWorkspaceConnection();
    if (!releaseConnection) {
      setTerminalSwitchBusy(false);
      return;
    }
    try {
      await window.grokDesktop.disconnect();
      setActiveSession(null);
      setMountedSessions({});
      setMainView("terminal");
    } catch (error) {
      pushNotice(userFacingErrorMessage(error, "无法切换 Grok 运行模式"), "error");
    } finally {
      releaseConnection();
      setTerminalSwitchBusy(false);
    }
  }, [acquireWorkspaceConnection, anyTaskBusy, connectWorkspace, mainView, pushNotice, terminalSwitchBusy, workspacePath]);

  const applyConnectionSettings = useCallback(async (
    targetWorkspacePath: string | null,
    settings: ConnectionSettingsDraft,
  ): Promise<boolean> => {
    try {
      const normalizedBaseUrl = normalizeXaiApiBaseUrl(settings.baseUrl);
      const normalizedSettings = {
        baseUrl: normalizedBaseUrl,
        apiKey: normalizeXaiApiKey(settings.apiKey),
        models: settings.models.map((model) => ({ ...model })),
        enabledModelIds: [...settings.enabledModelIds],
        permissionMode: settings.permissionMode,
        modelId: settings.modelId,
        reasoningEffort: settings.reasoningEffort,
        mcpServers: normalizeMcpServers(settings.mcpServers),
        allowStdioMcpExecution: settings.allowStdioMcpExecution,
      };
      if (!targetWorkspacePath) {
        if (normalizedSettings.mcpServers.length > 0) {
          throw new Error("请先选择工作区，再配置 MCP 服务器。");
        }
        const connectionError = validateXaiConnectionPair(
          normalizedSettings.baseUrl,
          normalizedSettings.apiKey,
          canUseStoredXaiCredential(normalizedSettings.baseUrl, storedXaiCredential),
        );
        if (connectionError) throw new Error(connectionError);
        const savedBaseUrl = await window.grokDesktop.setXaiApiBaseUrl(normalizedBaseUrl);
        const savedPermissionMode = await window.grokDesktop.setPermissionMode(
          normalizedSettings.permissionMode,
        );
        setBaseUrlPersistenceFailed(false);
        setXaiApiBaseUrl(savedBaseUrl ?? "");
        setXaiApiKey(normalizedSettings.apiKey);
        xaiApiKeyRef.current = normalizedSettings.apiKey;
        setModelCatalog(normalizedSettings.models);
        setEnabledModelIds(normalizedSettings.enabledModelIds);
        setReconnectModelPreference({
          modelId: normalizedSettings.modelId,
          reasoningEffort: normalizedSettings.modelId
            ? normalizedSettings.reasoningEffort
            : null,
        });
        setPermissionMode(savedPermissionMode);
        pushNotice("连接设置已保存，将在下次打开项目时应用");
        return true;
      }
      const snapshot = await connectWorkspace(targetWorkspacePath, normalizedSettings);
      if (!snapshot) return false;
      setXaiApiBaseUrl(snapshot.xaiApiBaseUrl ?? normalizedSettings.baseUrl);
      setXaiApiKey(normalizedSettings.apiKey);
      xaiApiKeyRef.current = normalizedSettings.apiKey;
      setModelCatalog(normalizedSettings.models.length > 0
        ? normalizedSettings.models
        : snapshot.availableModels);
      setEnabledModelIds(normalizedSettings.enabledModelIds.length > 0
        ? normalizedSettings.enabledModelIds
        : snapshot.availableModels.map((model) => model.id));
      setPermissionMode(normalizedSettings.permissionMode);
      return true;
    } catch (error) {
      pushNotice(
        redactSensitiveText(userFacingErrorMessage(error, "连接设置保存失败"), settings.apiKey.trim()),
        "error",
      );
      return false;
    }
  }, [connectWorkspace, pushNotice, storedXaiCredential]);

  const clearStoredXaiApiKey = useCallback(async (): Promise<boolean> => {
    try {
      const status = await window.grokDesktop.clearStoredXaiApiKey();
      setStoredXaiCredential(status);
      pushNotice("本机安全凭据库中的 API Key 已清除。", "info");
      return true;
    } catch (error) {
      pushNotice(userFacingErrorMessage(error, "无法清除本机 API Key"), "error");
      return false;
    }
  }, [pushNotice]);

  const disconnectFromSettings = useCallback(async () => {
    const releaseConnection = acquireWorkspaceConnection();
    if (!releaseConnection) return;
    try {
      await window.grokDesktop.disconnect();
      setRuntime(EMPTY_RUNTIME);
      setActiveSession(null);
      setMountedSessions({});
      setXaiApiKey("");
      xaiApiKeyRef.current = "";
      setModelCatalog([]);
      setEnabledModelIds([]);
      setReconnectModelPreference({ modelId: null, reasoningEffort: null });
      closeSettings();
    } catch (error) {
      pushNotice(userFacingErrorMessage(error, "断开连接失败"), "error");
    } finally {
      releaseConnection();
    }
  }, [acquireWorkspaceConnection, closeSettings, pushNotice]);

  const chooseWorkspace = async () => {
    if (workspaceConnectionBusyRef.current) return;
    try {
      const path = await window.grokDesktop.chooseWorkspace();
      if (path) await connectWorkspace(path);
    } catch (error) {
      pushNotice(userFacingErrorMessage(error, "无法选择项目文件夹"), "error");
    }
  };

  const chooseExecutable = async () => {
    try {
      const result = await window.grokDesktop.chooseExecutable();
      if (result) {
        setInstallation(result);
        pushNotice(result.found ? "Grok 程序位置已更新" : result.error ?? "所选文件不可用", result.found ? "info" : "error");
      }
    } catch (error) {
      pushNotice(userFacingErrorMessage(error, "无法选择 Grok 程序"), "error");
    }
  };

  const beginNewTask = useCallback(() => {
    if (!canUseSession || sessionBusy) return;
    timelineFollowingRef.current = true;
    setTimelineFollowPaused(false);
    setActiveSession(null);
    setMainView("conversation");
    setRailOpen(false);
  }, [canUseSession, sessionBusy]);

  const createSession = useCallback(async (title?: string): Promise<SessionReadyPayload | null> => {
    if (!canUseSession || sessionBusy) return null;
    const draftToMove = activeSession ? null : activeDraftKey;
    setSessionBusy(true);
    try {
      const ready = await window.grokDesktop.createSession(title);
      if (draftToMove) {
        const sessionDraftKey = composerDraftKey(ready.sessionId, ready.workspacePath);
        setComposerDrafts((drafts) =>
          moveComposerDraft(drafts, draftToMove, sessionDraftKey),
        );
      }
      acceptSession(ready);
      return ready;
    } catch (error) {
      pushNotice(userFacingErrorMessage(error, "新任务创建失败"), "error");
      return null;
    } finally {
      setSessionBusy(false);
    }
  }, [acceptSession, activeDraftKey, activeSession, canUseSession, pushNotice, sessionBusy]);

  const loadStoredSession = async (session: StoredSession) => {
    if (sessionBusy || activeSession?.sessionId === session.sessionId) {
      setRailOpen(false);
      return;
    }
    const retryingFailedLoad = Boolean(sessionLoadFailures[session.sessionId]);
    clearSessionLoadFailure(session.sessionId);
    const mounted = runtime.workspacePath === session.workspacePath
      ? mountedSessions[session.sessionId]
      : null;
    if (mounted) {
      setActiveSession(mounted);
      setMainView("conversation");
      setRailOpen(false);
      return;
    }

    const runtimeAlreadyHasSession = ["ready", "working", "waiting_permission"].includes(runtime.phase) &&
      runtime.workspacePath === session.workspacePath &&
      runtime.sessionExecutions.some((execution) => execution.sessionId === session.sessionId);
    const previousView = views[session.sessionId];
    setSessionBusy(true);
    try {
      if (runtime.workspacePath !== session.workspacePath || runtime.phase === "offline" || runtime.phase === "error") {
        const connected = await connectWorkspace(session.workspacePath);
        if (!connected) {
          setSessionLoadFailures((current) => ({
            ...current,
            [session.sessionId]: "连接尚未完成。完成连接设置后重试此任务。",
          }));
          return;
        }
      }
      if (!runtimeAlreadyHasSession) {
        setViews((current) => ({
          ...current,
          [session.sessionId]: createEmptySessionView(),
        }));
      }
      const ready = await window.grokDesktop.loadSession(session.sessionId);
      acceptSession(ready);
      setRailOpen(false);
    } catch (error) {
      if (!runtimeAlreadyHasSession) {
        setViews((current) => {
          const restored = { ...current };
          if (previousView) restored[session.sessionId] = previousView;
          else delete restored[session.sessionId];
          return restored;
        });
      }
      const detail = sessionLoadFailureDetail(error, xaiApiKeyRef.current);
      setSessionLoadFailures((current) => ({ ...current, [session.sessionId]: detail }));
      if (!retryingFailedLoad) pushNotice(detail, "error");
    } finally {
      setSessionBusy(false);
    }
  };

  const removeStoredSession = useCallback(async (session: StoredSession): Promise<boolean> => {
    const execution = executionForSession(runtime, session.sessionId);
    const mountedSessionIds = Object.keys(mountedSessions);
    if (!canRemoveStoredSession(
      session.sessionId,
      activeSession?.sessionId ?? null,
      mountedSessionIds,
      execution,
    )) {
      pushNotice("当前进程已加载或正在执行该任务，暂时不能从最近列表移除。", "warning");
      return false;
    }

    try {
      const remaining = await window.grokDesktop.removeRecentSession(session.sessionId);
      const draftKey = composerDraftKey(session.sessionId, session.workspacePath);
      setSessions(remaining);
      clearSessionLoadFailure(session.sessionId);
      setMountedSessions((current) => {
        if (!(session.sessionId in current)) return current;
        const next = { ...current };
        delete next[session.sessionId];
        return next;
      });
      setViews((current) => {
        if (!(session.sessionId in current)) return current;
        const next = { ...current };
        delete next[session.sessionId];
        return next;
      });
      setComposerDrafts((current) => {
        if (!(draftKey in current)) return current;
        const next = { ...current };
        delete next[draftKey];
        return next;
      });
      setContextFileDrafts((current) => {
        if (!(draftKey in current)) return current;
        const next = { ...current };
        delete next[draftKey];
        return next;
      });
      pushNotice("已从桌面端任务列表移除；Grok 原始会话未删除。");
      return true;
    } catch (error) {
      pushNotice(userFacingErrorMessage(error, "无法从桌面端任务列表移除"), "error");
      return false;
    }
  }, [activeSession?.sessionId, clearSessionLoadFailure, mountedSessions, pushNotice, runtime]);

  const chooseContextFiles = useCallback(async () => {
    if (!workspacePath || !canUseSession) return;
    try {
      const selected = await window.grokDesktop.chooseContextFiles(workspacePath);
      if (selected.length > 0) {
        setContextFiles((current) => mergeContextFiles(current, selected));
      }
    } catch (error) {
      pushNotice(userFacingErrorMessage(error, "无法引用工作区文件"), "error");
    }
  }, [canUseSession, pushNotice, setContextFiles, workspacePath]);

  const handleFileDragEnter = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
    dragDepth.current += 1;
    if (canAcceptDroppedFiles) setDropActive(true);
  }, [canAcceptDroppedFiles]);

  const handleFileDragOver = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = canAcceptDroppedFiles ? "copy" : "none";
  }, [canAcceptDroppedFiles]);

  const handleFileDragLeave = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDropActive(false);
  }, []);

  const handleFileDrop = useCallback(async (event: ReactDragEvent<HTMLDivElement>) => {
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDropActive(false);

    if (dropBusy) return;

    if (!workspacePath) {
      pushNotice("请先连接一个工作区，再拖入附件。", "warning");
      return;
    }
    if (mainView !== "conversation") {
      pushNotice("请先返回结构化任务，再拖入文件或图片。", "warning");
      return;
    }
    if (settingsOpen || permission) {
      pushNotice("请先完成当前弹窗操作，再拖入附件。", "warning");
      return;
    }
    if (!canUseSession) {
      pushNotice("Grok 连接尚未就绪，暂时不能添加附件。", "warning");
      return;
    }

    const droppedFiles = Array.from(event.dataTransfer.files);
    if (droppedFiles.length === 0) return;
    if (droppedFiles.length > MAX_PROMPT_CONTEXT_FILES) {
      pushNotice(`一次最多拖入 ${MAX_PROMPT_CONTEXT_FILES} 个附件。`, "warning");
      return;
    }

    setDropBusy(true);
    setDropActive(true);
    try {
      const filePaths = [...new Set(droppedFiles.map((file) =>
        window.grokDesktop.getPathForDroppedFile(file)
      ).filter(Boolean))];
      if (filePaths.length === 0) {
        throw new Error("拖入的内容不是可读取的本地文件。");
      }
      const resolved = await window.grokDesktop.resolveDroppedFiles(workspacePath, filePaths);
      if (resolved.length > 0) {
        setContextFiles((current) => mergeContextFiles(current, resolved));
        pushNotice(`已添加 ${resolved.length} 个附件。`);
      }
    } catch (error) {
      pushNotice(userFacingErrorMessage(error, "无法添加拖入的附件"), "error");
    } finally {
      setDropBusy(false);
      setDropActive(false);
    }
  }, [canUseSession, dropBusy, mainView, permission, pushNotice, setContextFiles, settingsOpen, workspacePath]);

  const submitPrompt = useCallback(async (textOverride?: string) => {
    const text = (textOverride ?? composer).trim();
    if (!text || !canUseSession || isWorking) return;
    timelineFollowingRef.current = true;
    setTimelineFollowPaused(false);
    const sourceDraftKey = activeDraftKey;
    const submittedContextFiles = contextFiles;
    let restoreDraftKey = sourceDraftKey;
    setSubmittingSessionId(activeSession?.sessionId ?? "pending");
    setComposer("");
    setContextFiles([]);
    let session = activeSession;
    try {
      if (!session) {
        session = await createSession(deriveLocalSessionTitle(
          text,
          submittedContextFiles.map((file) => file.name),
        ));
      }
      if (!session) {
        setComposer(text);
        setContextFiles(submittedContextFiles);
        return;
      }
      const receivedAt = new Date().toISOString();
      const sessionId = session.sessionId;
      restoreDraftKey = composerDraftKey(sessionId, session.workspacePath);
      setSubmittingSessionId(sessionId);
      setViews((current) => ({
        ...current,
        [sessionId]: addLocalPrompt(
          current[sessionId] ?? createEmptySessionView(),
          text,
          receivedAt,
          submittedContextFiles.map((file) => file.name),
        ),
      }));
      await window.grokDesktop.prompt({
        sessionId,
        text,
        ...(submittedContextFiles.length > 0
          ? { contextPaths: submittedContextFiles.map((file) => file.path) }
          : {}),
      });
    } catch (error) {
      setComposerDrafts((drafts) =>
        writeComposerDraft(
          drafts,
          restoreDraftKey,
          readComposerDraft(drafts, restoreDraftKey) || text,
        ),
      );
      setContextFileDrafts((drafts) => ({
        ...drafts,
        [restoreDraftKey]: mergeContextFiles(
          drafts[restoreDraftKey] ?? [],
          submittedContextFiles,
        ),
      }));
      pushNotice(userFacingErrorMessage(error, "消息发送失败"), "error");
    } finally {
      setSubmittingSessionId(null);
    }
  }, [activeDraftKey, activeSession, canUseSession, composer, contextFiles, createSession, isWorking, pushNotice, setComposer, setContextFiles]);

  const cancelTurn = async () => {
    if (!activeSession) return;
    try {
      await window.grokDesktop.cancel(activeSession.sessionId);
    } catch (error) {
      pushNotice(userFacingErrorMessage(error, "停止任务失败"), "error");
    }
  };

  const changeMode = async (modeId: string) => {
    if (!activeSession || !modeId || modeId === activeSession.currentModeId) return;
    const previous = activeSession;
    setActiveSession({ ...activeSession, currentModeId: modeId });
    try {
      await window.grokDesktop.setSessionMode(activeSession.sessionId, modeId);
    } catch (error) {
      setActiveSession(previous);
      pushNotice(userFacingErrorMessage(error, "会话模式切换失败"), "error");
    }
  };

  const changeConfig = async (configId: string, value: string | boolean) => {
    if (!activeSession || configBusyId) return;
    const option = currentView?.configOptions.find((candidate) => candidate.id === configId);
    if (!option) return;
    if (option.readOnly) {
      pushNotice(`${option.name} 由 Grok 当前版本提供只读能力，不能在此切换。`, "warning");
      return;
    }
    setConfigBusyId(configId);
    try {
      await window.grokDesktop.setSessionConfig(activeSession.sessionId, configId, value);
      pushNotice(`${option.name} 已更新`, "info");
    } catch (error) {
      pushNotice(userFacingErrorMessage(error, "会话配置更新失败"), "error");
    } finally {
      setConfigBusyId(null);
    }
  };

  const changeModel = async (modelId: string) => {
    const control = getActiveModelControl(currentView, runtime, activeEnabledModels);
    if (!control || !control.models.some((model) => model.id === modelId)) return;
    if (modelId === control.currentModelId || anyTaskBusy || workspaceConnectionBusyRef.current) return;

    if (control.strategy === "session" && control.configId && activeSession) {
      await changeConfig(control.configId, modelId);
      return;
    }
    if (
      !workspacePath ||
      !xaiApiBaseUrl ||
      (!xaiApiKey && !canUseStoredXaiCredential(xaiApiBaseUrl, storedXaiCredential))
    ) {
      pushNotice("切换进程模型需要当前 URL 和可用 API Key，请在设置中重新输入。", "warning");
      openSettings(workspacePath);
      return;
    }
    const mcpServers = readWorkspaceMcpServers(
      workspaceMcpConfigs,
      workspacePath,
      platform,
    );
    if (mcpServers.some((server) => server.type === "stdio")) {
      pushNotice("切换进程模型会重连；请在设置中重新确认本地 MCP 程序。", "warning");
      openSettings(workspacePath);
      return;
    }

    const snapshot = await connectWorkspace(workspacePath, {
      baseUrl: xaiApiBaseUrl,
      apiKey: xaiApiKey,
      models: modelCatalog,
      enabledModelIds,
      permissionMode,
      modelId,
      reasoningEffort: preferredReasoningEffort(modelCatalog, modelId) || null,
      mcpServers,
      allowStdioMcpExecution: false,
    });
    if (snapshot) {
      const modelName = activeEnabledModels.find((model) => model.id === modelId)?.name ?? modelId;
      pushNotice(`已使用 ${modelName} 重新连接；新任务将使用该模型。`);
    }
  };

  const resolvePermission = useCallback(async (optionId: string | null) => {
    if (!permission || permissionBusy) return;
    setPermissionBusy(true);
    try {
      await window.grokDesktop.resolvePermission({ requestId: permission.requestId, optionId });
      setPermissions((current) =>
        current.filter((item) => item.requestId !== permission.requestId),
      );
    } catch (error) {
      pushNotice(userFacingErrorMessage(error, "授权响应发送失败"), "error");
    } finally {
      setPermissionBusy(false);
    }
  }, [permission, permissionBusy, pushNotice]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (permission) void resolvePermission(null);
      else if (settingsOpen && !workspaceConnectionBusyRef.current) closeSettings();
      else {
        closeRail(railOpen);
        closeInspector(inspectorOpen);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeInspector, closeRail, closeSettings, inspectorOpen, permission, railOpen, resolvePermission, settingsOpen]);

  if (!bootstrap && !bootstrapError) return <LoadingScreen />;
  if (bootstrapError) return <FatalScreen message={bootstrapError} onRetry={() => {
    setBootstrapError(null);
    setBootstrap(null);
    setBootstrapAttempt((value) => value + 1);
  }} />;

  const recentWorkspaces = bootstrap?.settings.recentWorkspaces ?? [];
  const connectionMissing = !installation?.found;

  return (
    <div
      className="app"
      data-phase={runtime.phase}
      onDragEnter={handleFileDragEnter}
      onDragLeave={handleFileDragLeave}
      onDragOver={handleFileDragOver}
      onDrop={(event) => void handleFileDrop(event)}
    >
      <header className="app-topbar">
        <div className="app-topbar__content">
          <div className="app-topbar__leading">
            <button aria-controls="workspace-rail" aria-expanded={railOpen} className="icon-button mobile-only" aria-label={railOpen ? "关闭项目与任务" : "打开项目与任务"} onClick={() => { setRailOpen((open) => !open); setInspectorOpen(false); }} ref={railToggleRef} type="button"><MenuIcon /></button>
            <div className="brand-mark" aria-hidden="true"><span>G</span><i /></div>
            <div className="brand-copy"><strong>Grok</strong><span>桌面端</span></div>
          </div>
          <div className="app-topbar__context">
            {workspacePath ? <><FolderIcon size={15} /><span>{basename(workspacePath)}</span><small title={workspacePath}>本地工作区</small></> : <span>选择一个本地项目开始</span>}
          </div>
          <div className="app-topbar__actions">
            <RuntimePill runtime={runtime} terminalMode={mainView === "terminal"} />
            <button aria-pressed={mainView === "terminal"} className={`icon-button${mainView === "terminal" ? " is-active" : ""}`} aria-label={mainView === "terminal" ? "返回结构化任务" : "打开原始终端"} aria-busy={terminalSwitchBusy || workspaceConnectionBusy} disabled={!workspacePath || anyTaskBusy || terminalSwitchBusy || workspaceConnectionBusy} onClick={() => void toggleTerminal()} title={anyTaskBusy ? "请先停止所有正在运行的任务" : terminalSwitchBusy || workspaceConnectionBusy ? "正在切换 Grok 运行模式" : mainView === "terminal" ? "返回结构化任务" : "原始终端"} type="button">
              {mainView === "terminal" ? <ChatIcon /> : <TerminalIcon />}
            </button>
            <button aria-controls="task-inspector" aria-expanded={inspectorOpen} className={`icon-button inspector-toggle${inspectorOpen ? " is-active" : ""}`} aria-label={inspectorOpen ? "关闭任务检查器" : "打开任务检查器"} onClick={() => { setInspectorOpen((open) => !open); setRailOpen(false); }} ref={inspectorToggleRef} type="button"><PanelIcon /></button>
            <button className="icon-button" aria-label="打开设置" disabled={workspaceConnectionBusy} onClick={() => openSettings(workspacePath)} type="button"><SettingsIcon /></button>
          </div>
        </div>
      </header>

      <div className="workbench">
        {railOpen && <button className="drawer-scrim drawer-scrim--rail" aria-label="关闭项目与任务" onClick={() => closeRail(true)} type="button" />}
        {inspectorOpen && <button className="drawer-scrim drawer-scrim--inspector" aria-label="关闭任务检查器" onClick={() => closeInspector(true)} type="button" />}
        <WorkspaceRail
          activeSessionId={activeSession?.sessionId ?? null}
          canCreateSession={canUseSession}
          connectionBusy={workspaceConnectionBusy}
          currentWorkspace={workspacePath}
          executions={runtime.sessionExecutions}
          isOpen={railOpen}
          loadFailures={sessionLoadFailures}
          mountedSessionIds={Object.keys(mountedSessions)}
          onChooseWorkspace={() => void chooseWorkspace()}
          onCreateSession={beginNewTask}
          onLoadSession={(session) => void loadStoredSession(session)}
          onOpenSettings={() => { setRailOpen(false); openSettings(workspacePath); }}
          onRemoveSession={removeStoredSession}
          onSwitchWorkspace={(path) => void connectWorkspace(path)}
          recentWorkspaces={recentWorkspaces}
          sessions={workspaceSessions}
          sessionBusy={sessionBusy}
          taskBusy={anyTaskBusy}
          id="workspace-rail"
        />

        <main className="main-stage">
          {connectionMissing ? (
            <SetupState installation={installation} onChooseExecutable={() => void chooseExecutable()} />
          ) : !workspacePath ? (
            <WorkspaceEmpty connectionBusy={workspaceConnectionBusy} onChooseWorkspace={() => void chooseWorkspace()} recentWorkspaces={recentWorkspaces} onSwitchWorkspace={(path) => void connectWorkspace(path)} />
          ) : mainView === "terminal" ? (
            <Suspense fallback={<TerminalLoading />}>
              <TerminalPanel executablePath={installation?.executablePath} onNotice={pushNotice} workspacePath={workspacePath} />
            </Suspense>
          ) : (
            <ConversationStage
              activeSession={activeSession}
              baseUrlPersistenceFailed={baseUrlPersistenceFailed}
              canUseSession={canUseSession}
              composer={composer}
              connectionBusy={workspaceConnectionBusy}
              contextFiles={contextFiles}
              currentView={currentView}
              execution={currentExecution}
              isWorking={isWorking}
              models={activeEnabledModels}
              modelBusy={configBusyId !== null}
              onAttachContextFiles={() => void chooseContextFiles()}
              onCancel={() => void cancelTurn()}
              onChangeComposer={setComposer}
              onChangeMode={(modeId) => void changeMode(modeId)}
              onChangeModel={(modelId) => void changeModel(modelId)}
              onCreateSession={beginNewTask}
              onDismissReplayWarning={() => setReplayHistoryIncomplete(false)}
              onOpenConnectionSettings={() => openSettings(workspacePath)}
              onChangePermissionMode={(mode) => void changePermissionMode(mode)}
              onQuickPrompt={(prompt) => void submitPrompt(prompt)}
              onReconnect={() => {
                if (workspacePath) void connectWorkspace(workspacePath);
              }}
              onRemoveContextFile={(path) => setContextFiles((files) =>
                files.filter((file) => file.path !== path)
              )}
              onSelectCommand={(command) => setComposer(`/${command.name} `)}
              onSubmit={() => void submitPrompt()}
              onTimelineScroll={updateTimelineFollowing}
              onScrollToLatest={() => scrollTimelineToLatest("auto")}
              reconnectBlocked={anyTaskBusy}
              replayHistoryIncomplete={replayHistoryIncomplete}
              runtime={runtime}
              permissionMode={permissionMode}
              showScrollToLatest={timelineFollowPaused}
              timelineRef={timelineRef}
            />
          )}
        </main>

        <Inspector
          currentView={currentView}
          configBusyId={configBusyId}
          isOpen={inspectorOpen}
          onChangeConfig={(configId, value) => void changeConfig(configId, value)}
          onClose={() => closeInspector(true)}
          onSelectTab={setInspectorTab}
          tab={inspectorTab}
          id="task-inspector"
        />
      </div>

      {(dropActive || dropBusy) && (
        <div aria-live="polite" className="drop-plane" role="status">
          <div className="drop-plane__content">
            <span><ImageIcon size={24}/><FileIcon size={21}/></span>
            <strong>{dropBusy ? "正在验证附件" : "释放以添加到当前任务"}</strong>
            <small>{runtime.capabilities.prompt.image
              ? "图片将作为视觉输入，其他文件将作为工作区上下文"
              : "图片将作为文件引用，其他文件将作为工作区上下文"}</small>
          </div>
        </div>
      )}

      {settingsOpen && (
        <SettingsModal
          permissionMode={permissionMode}
          themePreference={themePreference}
          bootstrap={bootstrap!}
          key={workspaceMcpConfigKey(settingsWorkspacePath, platform) ?? "global-settings"}
          installation={installation}
          modelCatalog={modelCatalog}
          enabledModelIds={enabledModelIds}
          connectionBusy={workspaceConnectionBusy}
          onChooseExecutable={() => void chooseExecutable()}
          onClose={closeSettings}
          onDisconnect={() => void disconnectFromSettings()}
          onClearStoredXaiApiKey={clearStoredXaiApiKey}
          onChangeTheme={changeTheme}
          onApplyConnectionSettings={applyConnectionSettings}
          runtime={runtime}
          mcpServers={settingsMcpServers}
          taskBusy={anyTaskBusy}
          workspacePath={settingsWorkspacePath}
          xaiApiBaseUrl={xaiApiBaseUrl}
          xaiApiKey={xaiApiKey}
          storedXaiCredential={storedXaiCredential}
        />
      )}
      {permission && permissionSource && <PermissionModal busy={permissionBusy} frozen={permissionFrozen} isCurrentTask={permissionSource.isCurrentTask} onResolve={(optionId) => void resolvePermission(optionId)} permission={permission} queueLength={permissions.length} taskTitle={permissionSource.taskTitle} workspacePath={permissionSource.workspacePath} />}
      <ToastStack notices={notices} onDismiss={(id) => setNotices((items) => items.filter((item) => item.id !== id))} />
    </div>
  );
}

function LoadingScreen() {
  return <div className="loading-screen" role="status"><div className="brand-mark brand-mark--large"><span>G</span><i /></div><strong>正在准备 Grok Desktop</strong><span>检查本地运行环境…</span><div className="loading-line"><i /></div></div>;
}

function TerminalLoading() {
  return <div className="terminal-loading" role="status"><TerminalIcon size={20}/><span>正在载入原始终端…</span></div>;
}

function FatalScreen({ message, onRetry }: { message: string; onRetry(): void }) {
  return <div className="fatal-screen"><div className="fatal-screen__icon"><AlertIcon size={25} /></div><p className="eyebrow">启动异常</p><h1>桌面端没有完成初始化</h1><p>{message}</p><button className="primary-button" onClick={onRetry} type="button"><span>重新加载</span></button></div>;
}

function RuntimePill({ runtime, terminalMode }: { runtime: RuntimeSnapshot; terminalMode: boolean }) {
  if (terminalMode) {
    return <div aria-label="原始终端" className="runtime-pill" data-permission="none" data-phase="ready" role="status" title="Grok 原始 CLI 兼容模式"><i /><span>原始终端</span></div>;
  }
  const status = STATUS_COPY[runtime.phase];
  const label = runtime.permissionMode
    ? `${status} · ${permissionModeLabel(runtime.permissionMode)}`
    : status;
  return <div aria-label={label} className="runtime-pill" data-permission={runtime.permissionMode ?? "none"} data-phase={runtime.phase} role="status" title={runtime.message ?? label}><i /><span>{label}</span></div>;
}

interface WorkspaceRailProps {
  id?: string;
  currentWorkspace: string | null;
  canCreateSession: boolean;
  sessions: StoredSession[];
  executions: SessionExecutionSnapshot[];
  loadFailures: Readonly<Record<string, string>>;
  mountedSessionIds: string[];
  recentWorkspaces: BootstrapPayload["settings"]["recentWorkspaces"];
  activeSessionId: string | null;
  isOpen: boolean;
  connectionBusy: boolean;
  sessionBusy: boolean;
  taskBusy: boolean;
  onChooseWorkspace(): void;
  onSwitchWorkspace(path: string): void;
  onCreateSession(): void;
  onLoadSession(session: StoredSession): void;
  onRemoveSession(session: StoredSession): Promise<boolean>;
  onOpenSettings(): void;
}

function WorkspaceRail(props: WorkspaceRailProps) {
  const {
    currentWorkspace,
    canCreateSession,
    sessions,
    executions,
    loadFailures,
    mountedSessionIds,
    recentWorkspaces,
    activeSessionId,
    isOpen,
    connectionBusy,
    sessionBusy,
    taskBusy,
  } = props;
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false);
  const [sessionSearchQuery, setSessionSearchQuery] = useState("");
  const [pendingRemovalSessionId, setPendingRemovalSessionId] = useState<string | null>(null);
  const [removalBusyId, setRemovalBusyId] = useState<string | null>(null);
  const sessionSearchInputRef = useRef<HTMLInputElement>(null);
  const sessionSearchToggleRef = useRef<HTMLButtonElement>(null);
  const sessionCreateButtonRef = useRef<HTMLButtonElement>(null);
  const removalFocusTargetRef = useRef<{ sessionId: string; source: "menu" | "recovery" } | null>(null);
  const sessionSearchOffered = shouldOfferSessionSearch(sessions.length, sessionSearchOpen);
  const visibleSessions = useMemo(
    () => filterStoredSessions(sessions, sessionSearchQuery),
    [sessions, sessionSearchQuery],
  );
  const showSessionGroups = shouldGroupStoredSessions(sessions.length);
  const sessionGroups: Array<{ id: string; label: string; sessions: StoredSession[] }> = showSessionGroups
    ? groupStoredSessionsByRecency(visibleSessions)
    : [{ id: "all", label: "", sessions: visibleSessions }];

  useEffect(() => {
    setSessionSearchOpen(false);
    setSessionSearchQuery("");
    setPendingRemovalSessionId(null);
  }, [currentWorkspace]);

  useEffect(() => {
    if (!sessionSearchOpen) return;
    sessionSearchInputRef.current?.focus({ preventScroll: true });
  }, [sessionSearchOpen]);

  const closeSessionSearch = () => {
    setSessionSearchQuery("");
    setSessionSearchOpen(false);
    window.requestAnimationFrame(() => {
      (sessionSearchToggleRef.current ?? sessionCreateButtonRef.current)?.focus();
    });
  };

  const closeRemovalConfirmation = (restoreFocus = false) => {
    setPendingRemovalSessionId(null);
    if (restoreFocus) {
      const target = removalFocusTargetRef.current;
      window.requestAnimationFrame(() => {
        if (!target) return;
        const trigger = Array.from(document.querySelectorAll<HTMLButtonElement>(
          "[data-session-removal-trigger]",
        )).find((button) =>
          button.dataset.sessionId === target.sessionId &&
          button.dataset.sessionRemovalTrigger === target.source
        );
        trigger?.focus();
      });
    }
  };

  const confirmSessionRemoval = async (session: StoredSession) => {
    if (removalBusyId) return;
    setRemovalBusyId(session.sessionId);
    try {
      if (await props.onRemoveSession(session)) {
        setPendingRemovalSessionId(null);
      }
    } finally {
      setRemovalBusyId(null);
    }
  };

  return (
    <aside className={`workspace-rail${isOpen ? " is-open" : ""}`} aria-label="项目和任务" id={props.id}>
      <section className="rail-section rail-section--workspace">
        <span className="rail-label">当前项目</span>
        <button className="workspace-selector" disabled={taskBusy || connectionBusy} onClick={props.onChooseWorkspace} title={taskBusy ? "请先停止正在运行的任务" : connectionBusy ? "正在连接项目" : undefined} type="button">
          <span className="workspace-selector__icon"><FolderIcon size={17} /></span>
          <span><strong>{currentWorkspace ? basename(currentWorkspace) : "选择项目"}</strong><small>{currentWorkspace || "打开本地文件夹"}</small></span>
          <ChevronIcon size={15} />
        </button>
        {recentWorkspaces.length > 1 && (
          <details className="recent-workspaces">
            <summary>最近项目</summary>
            <div>{recentWorkspaces.filter((item) => item.path !== currentWorkspace).slice(0, 5).map((item) => <button disabled={taskBusy || connectionBusy} key={item.path} onClick={() => props.onSwitchWorkspace(item.path)} title={taskBusy ? "请先停止正在运行的任务" : connectionBusy ? "正在连接项目" : item.path} type="button"><FolderIcon size={14}/><span>{item.label || basename(item.path)}</span></button>)}</div>
          </details>
        )}
      </section>
      <section className="rail-section rail-section--sessions">
        <div className="rail-section__header">
          <span className="rail-label">任务</span>
          <div className="rail-section__actions">
            {sessionSearchOffered && (
              <button
                aria-controls="session-search"
                aria-expanded={sessionSearchOpen}
                aria-label={sessionSearchOpen ? "关闭任务搜索" : "搜索任务"}
                className={sessionSearchOpen ? "is-active" : undefined}
                onClick={() => sessionSearchOpen ? closeSessionSearch() : setSessionSearchOpen(true)}
                ref={sessionSearchToggleRef}
                title={sessionSearchOpen ? "关闭搜索" : "搜索任务"}
                type="button"
              >
                <SearchIcon size={15}/>
              </button>
            )}
            <button aria-label="新建任务" disabled={!currentWorkspace || !canCreateSession || sessionBusy || connectionBusy} onClick={props.onCreateSession} ref={sessionCreateButtonRef} title={canCreateSession ? connectionBusy ? "正在连接项目" : "新建任务" : "连接 Grok 后新建任务"} type="button"><PlusIcon size={16}/></button>
          </div>
        </div>
        {sessionSearchOpen && (
          <div className="session-search" id="session-search" role="search">
            <SearchIcon size={14}/>
            <input
              aria-label="搜索任务"
              autoComplete="off"
              maxLength={120}
              onChange={(event) => setSessionSearchQuery(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.preventDefault();
                event.stopPropagation();
                if (sessionSearchEscapeAction(sessionSearchQuery) === "clear") {
                  setSessionSearchQuery("");
                } else {
                  closeSessionSearch();
                }
              }}
              placeholder="搜索任务"
              ref={sessionSearchInputRef}
              type="search"
              value={sessionSearchQuery}
            />
            {sessionSearchQuery && <button aria-label="清空任务搜索" onClick={() => setSessionSearchQuery("")} type="button"><CloseIcon size={13}/></button>}
          </div>
        )}
        <div className="session-list">
          {visibleSessions.length ? sessionGroups.map((group) => (
            <section className="session-group" key={group.id}>
              {group.label && <h3 className="session-group__label">{group.label}</h3>}
              {group.sessions.map((session) => {
                const execution = executions.find((item) => item.sessionId === session.sessionId);
                const status = executionLabel(execution);
                const removable = canRemoveStoredSession(
                  session.sessionId,
                  activeSessionId,
                  mountedSessionIds,
                  execution,
                );
                const removalPending = pendingRemovalSessionId === session.sessionId;
                const removalBusy = removalBusyId === session.sessionId;
                const loadFailure = loadFailures[session.sessionId] ?? null;
                return (
                  <div className={`session-row-shell${removalPending ? " is-confirming" : ""}${loadFailure ? " is-load-failed" : ""}`} key={session.sessionId}>
                    <button
                      aria-current={session.sessionId === activeSessionId ? "page" : undefined}
                      className={`session-row${session.sessionId === activeSessionId ? " is-active" : ""}`}
                      data-execution={execution?.phase ?? "idle"}
                      disabled={sessionBusy || connectionBusy || removalBusy}
                      onClick={() => props.onLoadSession(session)}
                      title={session.title || "未命名任务"}
                      type="button"
                    >
                      <i aria-hidden="true" />
                      <span>
                        <strong>{session.title || "未命名任务"}</strong>
                        <small>{loadFailure ? "加载失败" : status ?? formatRelativeDate(session.updatedAt)}</small>
                      </span>
                    </button>
                    {removable && (
                      <button
                        aria-controls={`remove-session-${session.sessionId}`}
                        aria-expanded={removalPending}
                        aria-label={`从桌面端列表移除 ${session.title || "未命名任务"}`}
                        className="session-row__menu"
                        data-session-id={session.sessionId}
                        data-session-removal-trigger="menu"
                        disabled={sessionBusy || connectionBusy || Boolean(removalBusyId)}
                        onClick={(event) => {
                          removalFocusTargetRef.current = { sessionId: session.sessionId, source: "menu" };
                          setPendingRemovalSessionId(removalPending ? null : session.sessionId);
                        }}
                        title="从桌面端列表移除"
                        type="button"
                      >
                        <MoreIcon size={15}/>
                      </button>
                    )}
                    {removalPending && (
                      <div
                        aria-label="确认移除桌面端任务记录"
                        className="session-remove-confirmation"
                        id={`remove-session-${session.sessionId}`}
                        onKeyDown={(event) => {
                          if (event.key !== "Escape") return;
                          event.preventDefault();
                          event.stopPropagation();
                          closeRemovalConfirmation(true);
                        }}
                        role="dialog"
                      >
                        <div><strong>从列表移除？</strong><small>不会删除 Grok 原始会话或文件。</small></div>
                        <div className="session-remove-confirmation__actions">
                          <button autoFocus disabled={removalBusy} onClick={() => closeRemovalConfirmation(true)} type="button">取消</button>
                          <button aria-busy={removalBusy} className="is-danger" disabled={removalBusy} onClick={() => void confirmSessionRemoval(session)} type="button">{removalBusy ? "正在移除…" : "移除"}</button>
                        </div>
                      </div>
                    )}
                    {loadFailure && !removalPending && (
                      <div className="session-load-recovery" role="alert">
                        <AlertIcon size={13}/>
                        <div><strong>这个任务没有加载</strong><small title={loadFailure}>{loadFailure}</small></div>
                        <div className="session-load-recovery__actions">
                          <button disabled={sessionBusy || connectionBusy || removalBusy} onClick={() => props.onLoadSession(session)} type="button">重试</button>
                          {removable && (
                            <button
                              aria-controls={`remove-session-${session.sessionId}`}
                              className="is-danger"
                              data-session-id={session.sessionId}
                              data-session-removal-trigger="recovery"
                              disabled={sessionBusy || connectionBusy || Boolean(removalBusyId)}
                              onClick={() => {
                                removalFocusTargetRef.current = { sessionId: session.sessionId, source: "recovery" };
                                setPendingRemovalSessionId(session.sessionId);
                              }}
                              type="button"
                            >
                              从列表移除
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </section>
          )) : sessions.length && sessionSearchQuery.trim() ? (
            <div className="rail-empty rail-empty--search"><SearchIcon size={18}/><span>没有匹配的任务</span><small>换个关键词试试</small></div>
          ) : (
            <div className="rail-empty"><ChatIcon size={19}/><span>{currentWorkspace ? "这个项目还没有任务" : "选择项目后可创建任务"}</span></div>
          )}
        </div>
      </section>
      <div className="rail-footer"><button disabled={connectionBusy} onClick={props.onOpenSettings} type="button"><SettingsIcon size={16}/><span>设置</span></button><span>本机 · ACP</span></div>
    </aside>
  );
}

function SetupState({ installation, onChooseExecutable }: { installation: GrokInstallation | null; onChooseExecutable(): void }) {
  return (
    <section className="centered-state">
      <div className="state-glyph"><span>G</span><i /></div>
      <p className="eyebrow">需要完成一次本地配置</p>
      <h1>找到 Grok，桌面端才知道从哪里启动。</h1>
      <p>{installation?.error || "没有在常用位置发现 grok.exe。请选择你电脑上现有的 Grok 可执行程序，桌面端不会复制或修改它。"}</p>
      <button className="primary-button" onClick={onChooseExecutable} type="button"><FolderIcon size={16}/><span>选择 grok.exe</span></button>
      <small>凭据、配置和更新仍由原 Grok CLI 管理。</small>
    </section>
  );
}

function WorkspaceEmpty({ connectionBusy, onChooseWorkspace, recentWorkspaces, onSwitchWorkspace }: { connectionBusy: boolean; onChooseWorkspace(): void; recentWorkspaces: BootstrapPayload["settings"]["recentWorkspaces"]; onSwitchWorkspace(path: string): void }) {
  return (
    <section className="centered-state workspace-empty-state">
      <div className="state-glyph state-glyph--folder"><FolderIcon size={27}/><i /></div>
      <p className="eyebrow">本地工作区</p>
      <h1>从一个项目开始。</h1>
      <p>Grok 会在你选择的目录中读取、运行和修改文件。桌面端只提供更清晰的任务视图。</p>
      <button className="primary-button" disabled={connectionBusy} onClick={onChooseWorkspace} type="button"><FolderIcon size={16}/><span>{connectionBusy ? "正在连接…" : "打开项目文件夹"}</span></button>
      {recentWorkspaces.length > 0 && <div className="recent-project-grid">{recentWorkspaces.slice(0, 3).map((workspace) => <button disabled={connectionBusy} key={workspace.path} onClick={() => onSwitchWorkspace(workspace.path)} title={workspace.path} type="button"><FolderIcon size={15}/><span><strong>{workspace.label || basename(workspace.path)}</strong><small>{workspace.path}</small></span><ChevronIcon size={14}/></button>)}</div>}
    </section>
  );
}

interface ConversationStageProps {
  activeSession: SessionReadyPayload | null;
  baseUrlPersistenceFailed: boolean;
  currentView?: SessionViewState;
  execution?: SessionExecutionSnapshot;
  runtime: RuntimeSnapshot;
  permissionMode: PermissionModePreference;
  canUseSession: boolean;
  connectionBusy: boolean;
  isWorking: boolean;
  models: ModelInfo[];
  modelBusy: boolean;
  composer: string;
  contextFiles: ContextFileReference[];
  reconnectBlocked: boolean;
  replayHistoryIncomplete: boolean;
  timelineRef: React.RefObject<HTMLDivElement | null>;
  onCreateSession(): void;
  onAttachContextFiles(): void;
  onChangeMode(modeId: string): void;
  onChangeModel(modelId: string): void;
  onChangePermissionMode(mode: PermissionModePreference): void;
  onChangeComposer(value: string): void;
  onSubmit(): void;
  onCancel(): void;
  onDismissReplayWarning(): void;
  onOpenConnectionSettings(): void;
  onQuickPrompt(prompt: string): void;
  onReconnect(): void;
  onRemoveContextFile(path: string): void;
  onSelectCommand(command: AvailableCommand): void;
  onTimelineScroll(): void;
  onScrollToLatest(): void;
  showScrollToLatest: boolean;
}

function ConversationStage(props: ConversationStageProps) {
  const { activeSession, currentView, execution, runtime, isWorking, canUseSession } = props;
  const isCancelling = execution?.phase === "cancelling";
  const [commandIndex, setCommandIndex] = useState(0);
  const [commandMenuDismissed, setCommandMenuDismissed] = useState(false);
  const commandMenuRef = useRef<HTMLDivElement>(null);
  const timeline = currentView?.timeline ?? [];
  const commands = currentView?.availableCommands ?? activeSession?.availableCommands ?? [];
  const commandMatch = props.composer.match(/^\/(\S*)$/);
  const commandQuery = commandMatch?.[1]?.toLocaleLowerCase("en-US") ?? "";
  const visibleCommands = filterAvailableCommands(commands, commandQuery);
  const commandMenuOpen = Boolean(commandMatch) &&
    visibleCommands.length > 0 &&
    !commandMenuDismissed;
  const selectedCommandIndex = Math.min(commandIndex, Math.max(visibleCommands.length - 1, 0));
  const selectCommand = (command: AvailableCommand) => {
    setCommandMenuDismissed(true);
    props.onSelectCommand(command);
  };
  useEffect(() => {
    setCommandIndex(0);
    setCommandMenuDismissed(false);
  }, [commandQuery, activeSession?.sessionId]);
  useEffect(() => {
    if (!commandMenuOpen) return;
    commandMenuRef.current
      ?.querySelector<HTMLElement>(`[data-command-index="${selectedCommandIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [commandMenuOpen, selectedCommandIndex]);
  const outcome = currentView?.turnOutcome ?? executionTurnOutcome(execution);
  const outcomePresentation = outcome ? turnOutcomePresentation(outcome) : null;
  const visibleOutcomePresentation = isWorking ? null : outcomePresentation;
  const outcomeDetail = currentView?.turnError || execution?.error || outcomePresentation?.detail || null;
  const modelLabel = getActiveModelLabel(currentView, runtime);
  const modelControl = getActiveModelControl(currentView, runtime, props.models);
  const connectionBadge = getXaiConnectionBadge(runtime);
  const presentationTimeline = useMemo(
    () => projectTimelinePresentation(timeline),
    [timeline],
  );
  const hasTimelineContent = presentationTimeline.length > 0 || visibleOutcomePresentation !== null;
  return (
    <section aria-busy={isWorking} className="conversation-stage">
      <header className="conversation-header">
        <div><p>{activeSession ? "当前任务" : "项目已连接"}</p><h1>{activeSession?.title || "准备开始新任务"}</h1></div>
        <div className="conversation-header__controls">
          {activeSession && activeSession.availableModes.length > 0 && (
            <label className="mode-select"><span>模式</span><select aria-label="会话模式" onChange={(event) => props.onChangeMode(event.target.value)} value={activeSession.currentModeId ?? ""}>{!activeSession.currentModeId && <option value="">默认</option>}{activeSession.availableModes.map((mode) => <option key={mode.id} value={mode.id}>{mode.name}</option>)}</select></label>
          )}
          <button className="subtle-button" disabled={!canUseSession || isWorking} onClick={props.onCreateSession} type="button"><PlusIcon size={15}/>新任务</button>
        </div>
      </header>

      <ConversationAlerts
        baseUrlPersistenceFailed={props.baseUrlPersistenceFailed}
        connectionBusy={props.connectionBusy}
        onDismissReplayWarning={props.onDismissReplayWarning}
        onOpenConnectionSettings={props.onOpenConnectionSettings}
        onReconnect={props.onReconnect}
        reconnectBlocked={props.reconnectBlocked}
        replayHistoryIncomplete={props.replayHistoryIncomplete}
        runtime={runtime}
      />

      <div aria-busy={isWorking} className="timeline" onScroll={props.onTimelineScroll} ref={props.timelineRef}>
        {!hasTimelineContent ? (
          <ConversationEmpty active={Boolean(activeSession)} disabled={!canUseSession || isWorking} onQuickPrompt={props.onQuickPrompt} />
        ) : (
          <div className="timeline__inner">
            {presentationTimeline.map((entry) => entry.type === "message"
              ? <TimelineEntry item={entry.item} key={entry.item.id} />
              : <ExecutionGroup entry={entry} key={entry.id} />)}
            {isWorking && <WorkingTail phase={execution?.phase ?? (runtime.phase === "waiting_permission" ? "waiting_permission" : "working")} />}
            {visibleOutcomePresentation && <TurnStatusEntry detail={outcomeDetail} presentation={visibleOutcomePresentation} />}
          </div>
        )}
      </div>

      <div className="composer-wrap">
        {props.showScrollToLatest && <button aria-label="回到最新消息" className="timeline-jump" onClick={props.onScrollToLatest} title="回到最新消息" type="button"><ChevronIcon size={16}/></button>}
        <div className={`composer${isWorking ? " is-working" : ""}`}>
          {props.contextFiles.length > 0 && (
            <div className="composer-context" aria-label="已添加的附件">
              {props.contextFiles.map((file) => (
                <span className={`composer-context__file${file.kind === "image" ? " is-image" : ""}`} key={file.path} title={file.path}>
                  {file.kind === "image" ? <ImageIcon size={13}/> : <FileIcon size={13}/>}
                  <span><strong>{file.relativePath}</strong><small>{file.kind === "image" ? "图片" : "上下文文件"} · {formatAttachmentSize(file.size)}</small></span>
                  <button aria-label={`移除 ${file.relativePath}`} onClick={() => props.onRemoveContextFile(file.path)} type="button"><CloseIcon size={12}/></button>
                </span>
              ))}
            </div>
          )}
          <button aria-label="添加文件或图片" className="composer__attach" disabled={!canUseSession} onClick={props.onAttachContextFiles} title="选择或拖入工作区文件；附件仅随本次请求发送" type="button"><PlusIcon size={17}/></button>
          <textarea
            aria-activedescendant={commandMenuOpen ? `composer-command-${selectedCommandIndex}` : undefined}
            aria-controls={commandMenuOpen ? "composer-command-menu" : undefined}
            aria-expanded={commandMenuOpen}
            aria-label="给 Grok 发送任务"
            disabled={!canUseSession}
            onChange={(event) => {
              setCommandMenuDismissed(false);
              props.onChangeComposer(event.target.value);
            }}
            onKeyDown={(event) => {
              if (commandMenuOpen) {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  setCommandIndex((current) => moveCommandSelection(
                    current,
                    event.key === "ArrowDown" ? 1 : -1,
                    visibleCommands.length,
                  ));
                  return;
                }
                if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
                  event.preventDefault();
                  const command = visibleCommands[selectedCommandIndex];
                  if (command) selectCommand(command);
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setCommandMenuDismissed(true);
                  return;
                }
              }
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                if (!isWorking) {
                  event.preventDefault();
                  props.onSubmit();
                }
              }
            }}
            placeholder={canUseSession ? "描述任务，或询问这个项目…" : "等待 Grok 连接…"}
            rows={1}
            value={props.composer}
          />
          {commandMenuOpen && (
            <div className="composer-commands" id="composer-command-menu" ref={commandMenuRef} role="listbox" aria-label="Grok 命令">
              <div className="composer-commands__heading"><span>命令</span><small>{visibleCommands.length} 个 · 输入名称可筛选</small></div>
              {visibleCommands.map((command, index) => (
                <button aria-posinset={index + 1} aria-selected={index === selectedCommandIndex} aria-setsize={visibleCommands.length} className={`composer-command${index === selectedCommandIndex ? " is-selected" : ""}`} data-command-index={index} id={`composer-command-${index}`} key={command.name} onMouseDown={(event) => event.preventDefault()} onClick={() => selectCommand(command)} role="option" type="button">
                  <strong>/{command.name}</strong><span>{command.description || "无描述"}</span>{command.inputHint && <small>{command.inputHint}</small>}
                </button>
              ))}
            </div>
          )}
          {isWorking ? <button aria-busy={isCancelling} aria-label={isCancelling ? "正在停止执行" : "停止执行"} className="composer__action composer__action--stop" disabled={isCancelling} onClick={props.onCancel} title={isCancelling ? "正在等待 Grok 确认停止" : "停止执行"} type="button"><StopIcon size={16}/></button> : <button className="composer__action" aria-label="发送" disabled={!props.composer.trim() || !canUseSession} onClick={props.onSubmit} type="button"><ArrowUpIcon size={17}/></button>}
        </div>
        <div className="composer-meta">{modelControl ? <label className="composer-model-select" title={modelControl.strategy === "session" ? "切换当前会话模型" : "切换后会重新连接，历史任务仍保留"}><span>模型</span><select aria-label="当前模型" disabled={isWorking || props.connectionBusy || props.modelBusy || props.reconnectBlocked} onChange={(event) => props.onChangeModel(event.target.value)} value={modelControl.currentModelId}>{modelControl.models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label> : <span>{modelLabel}</span>}{connectionBadge && <button className="composer-connection" data-key-configured={connectionBadge.keyConfigured} onClick={props.onOpenConnectionSettings} title={connectionBadge.title} type="button"><i/>{connectionBadge.label}</button>}<PermissionModeControl disabled={props.connectionBusy || props.reconnectBlocked} mode={runtime.permissionMode ?? props.permissionMode} onChange={props.onChangePermissionMode}/><span className="composer-shortcut">Enter 发送 · Shift+Enter 换行</span>{props.contextFiles.length > 0 && <span>{props.contextFiles.length} 个附件</span>}<UsageDisclosure view={currentView}/></div>
      </div>
    </section>
  );
}

function PermissionModeControl({
  disabled,
  mode,
  onChange,
}: {
  disabled: boolean;
  mode: PermissionModePreference;
  onChange(mode: PermissionModePreference): void;
}) {
  const [open, setOpen] = useState(false);
  const [confirmDanger, setConfirmDanger] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const current = PERMISSION_MODE_OPTIONS.find((option) => option.id === mode)
    ?? PERMISSION_MODE_OPTIONS[0]!;

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setOpen(false);
      setConfirmDanger(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [open]);

  useEffect(() => {
    if (!disabled) return;
    setOpen(false);
    setConfirmDanger(false);
  }, [disabled]);

  const choose = (nextMode: PermissionModePreference) => {
    if (nextMode === "always_approve" && mode !== "always_approve") {
      setConfirmDanger(true);
      return;
    }
    setOpen(false);
    setConfirmDanger(false);
    if (nextMode !== mode) onChange(nextMode);
  };

  return (
    <div
      className="permission-mode-control"
      data-mode={mode}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        setConfirmDanger(false);
        triggerRef.current?.focus();
      }}
      ref={rootRef}
    >
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`权限模式：${current.label}`}
        className={current.danger ? "permission-mode-control__trigger is-danger" : "permission-mode-control__trigger"}
        disabled={disabled}
        onClick={() => {
          setOpen((visible) => !visible);
          setConfirmDanger(false);
        }}
        ref={triggerRef}
        title={disabled ? "请先停止当前任务，再切换权限模式" : "切换 Grok 工具授权方式"}
        type="button"
      >
        <i />
        <span>权限：{current.label}</span>
        <ChevronIcon size={11}/>
      </button>
      {open && (
        <div aria-label="权限模式" className="permission-mode-menu" role="menu">
          <div className="permission-mode-menu__heading">
            <strong>权限模式</strong>
            <span>切换后会重新连接 Grok</span>
          </div>
          <div className="permission-mode-menu__options">
            {PERMISSION_MODE_OPTIONS.map((option) => (
              <button
                aria-checked={option.id === mode}
                className={`${option.danger ? "is-danger " : ""}${option.id === mode ? "is-selected" : ""}`.trim()}
                data-permission-option={option.id}
                key={option.id}
                onClick={() => choose(option.id)}
                role="menuitemradio"
                type="button"
              >
                <span className="permission-mode-menu__check">
                  {option.id === mode && <CheckIcon size={13}/>}
                </span>
                <span>
                  <strong>{option.label}{option.recommended && <em>推荐</em>}</strong>
                  <small>{option.description}</small>
                </span>
              </button>
            ))}
          </div>
          {confirmDanger && (
            <div className="permission-mode-confirm" role="alert">
              <strong>确认启用完全授权？</strong>
              <p>Grok 将不再询问工具操作。请只在你信任当前项目及其指令时使用。</p>
              <div>
                <button onClick={() => setConfirmDanger(false)} type="button">取消</button>
                <button className="is-danger" onClick={() => {
                  setOpen(false);
                  setConfirmDanger(false);
                  onChange("always_approve");
                }} type="button">启用完全授权</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ConversationAlerts({
  baseUrlPersistenceFailed,
  connectionBusy,
  onDismissReplayWarning,
  onOpenConnectionSettings,
  onReconnect,
  reconnectBlocked,
  replayHistoryIncomplete,
  runtime,
}: {
  baseUrlPersistenceFailed: boolean;
  connectionBusy: boolean;
  onDismissReplayWarning(): void;
  onOpenConnectionSettings(): void;
  onReconnect(): void;
  reconnectBlocked: boolean;
  replayHistoryIncomplete: boolean;
  runtime: RuntimeSnapshot;
}) {
  const alerts = getConversationAlerts(runtime, replayHistoryIncomplete, baseUrlPersistenceFailed);
  return (
    <div aria-label="连接与恢复状态" className="conversation-alerts">
      {alerts.map((alert) => (
        <section className="conversation-alert" data-tone={alert.tone} key={alert.id} role={alert.tone === "error" ? "alert" : "status"} title={alert.detail}>
          <AlertIcon size={15}/>
          <div className="conversation-alert__copy"><strong>{alert.title}</strong><span>{alert.detail}</span></div>
          <div className="conversation-alert__actions">
            {alert.reconnect && <button className="subtle-button" disabled={connectionBusy || reconnectBlocked} onClick={onReconnect} title={reconnectBlocked ? "请先停止当前任务，再重新连接" : undefined} type="button">{connectionBusy ? "正在连接…" : "重新连接"}</button>}
            {alert.settings && <button className="subtle-button" disabled={connectionBusy} onClick={onOpenConnectionSettings} type="button">连接设置</button>}
            {alert.dismissible && <button aria-label="关闭恢复提示" className="conversation-alert__dismiss" onClick={onDismissReplayWarning} title="关闭" type="button"><CloseIcon size={13}/></button>}
          </div>
        </section>
      ))}
    </div>
  );
}

function UsageDisclosure({ view }: { view: SessionViewState | undefined }) {
  const label = getUsageLabel(view);
  const rows = getUsageDetailRows(view);
  if (!label || rows.length === 0) return null;
  return (
    <details className="usage-disclosure">
      <summary aria-label={`查看 Grok ${label}`}><span>{label}</span><ChevronIcon size={10}/></summary>
      <div className="usage-disclosure__panel">
        <header><strong>会话用量</strong><span>Grok 返回</span></header>
        <dl>{rows.map((row) => <div key={row.id}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl>
        <small>仅显示当前会话返回的字段，不推算缺失数据。</small>
      </div>
    </details>
  );
}

function ConversationEmpty({ active, disabled, onQuickPrompt }: { active: boolean; disabled: boolean; onQuickPrompt(prompt: string): void }) {
  return <div className="conversation-empty"><div className="conversation-empty__signal"><i/><span/></div><SparkIcon size={21}/><p className="eyebrow">{active ? "任务已就绪" : "Grok 已连接"}</p><h2>{active ? "告诉 Grok 接下来要做什么。" : "新建任务，或直接输入第一条指令。"}</h2><p>执行过程、计划和文件变化会保持可见，敏感操作仍会等待你的授权。</p><div className="quick-prompts">{QUICK_PROMPTS.map((prompt) => <button disabled={disabled} key={prompt} onClick={() => onQuickPrompt(prompt)} type="button"><span>{prompt}</span><ChevronIcon size={14}/></button>)}</div></div>;
}

function TimelineEntry({ item }: { item: ConversationMessageTimelineItem }) {
  return (
    <article className={`timeline-entry timeline-entry--message timeline-entry--${item.role}`}>
      <div className="timeline-entry__content">
        <MessageEntry item={item} />
      </div>
    </article>
  );
}

function MessageEntry({ item }: { item: ConversationMessageTimelineItem }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const resetCopyTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (resetCopyTimer.current !== null) window.clearTimeout(resetCopyTimer.current);
  }, []);
  const copyResponse = async () => {
    const copied = await copyTextToClipboard(item.text);
    setCopyState(copied ? "copied" : "failed");
    if (resetCopyTimer.current !== null) window.clearTimeout(resetCopyTimer.current);
    resetCopyTimer.current = window.setTimeout(() => setCopyState("idle"), 1600);
  };
  return <div className={`message-entry message-entry--${item.role}`}><span className="sr-only">{item.role === "user" ? "你的消息" : "Grok 回复"}</span>{item.text && <RichText text={item.text}/>} {item.contextFiles.length > 0 && <div className="message-context" aria-label="引用文件">{item.contextFiles.map((file) => <span key={file}><FileIcon size={13}/>{file}</span>)}</div>}{item.role === "agent" && item.text && <div className="message-actions"><button aria-label={copyState === "copied" ? "已复制 Grok 回复" : copyState === "failed" ? "复制失败，请重试" : "复制 Grok 回复"} data-state={copyState} onClick={() => void copyResponse()} title={copyState === "copied" ? "已复制" : copyState === "failed" ? "复制失败，请重试" : "复制回复"} type="button">{copyState === "copied" ? <CheckIcon size={14}/> : <CopyIcon size={14}/>}<span aria-live="polite" className="sr-only">{copyState === "copied" ? "回复已复制" : copyState === "failed" ? "复制失败" : ""}</span></button></div>}</div>;
}

function ExecutionGroup({ entry }: { entry: ExecutionGroupEntry }) {
  const summary = summarizeExecutionGroup(entry.items);
  const tone = summary.tone;
  const [open, setOpen] = useState(tone === "working");
  const previousToneRef = useRef(tone);
  useEffect(() => {
    const previousTone = previousToneRef.current;
    previousToneRef.current = tone;
    setOpen((currentOpen) => nextExecutionDisclosureOpen(currentOpen, previousTone, tone));
  }, [tone]);

  return (
    <article className="timeline-entry timeline-entry--execution">
      <details className="execution-group" data-tone={tone} onToggle={(event) => setOpen(event.currentTarget.open)} open={open}>
        <summary>
          <span className="execution-group__indicator" />
          <span className="execution-group__label"><strong>{summary.label}</strong>{summary.detail && <small>{summary.detail}</small>}</span>
          <ChevronIcon className="execution-group__chevron" size={14}/>
        </summary>
        <div className="execution-group__body">
          {entry.items.map((item) => <ExecutionGroupItem item={item} key={item.id} />)}
        </div>
      </details>
    </article>
  );
}

function ExecutionGroupItem({ item }: { item: ExecutionTimelineItem }) {
  if (item.kind === "message") {
    return <div className="execution-group__thought"><RichText compact text={item.text}/></div>;
  }
  if (item.kind === "tool") return <ToolEntry item={item} />;
  return <PlanEntry note={item.note} plan={item.entries} />;
}

function ToolEntry({ item }: { item: ToolTimelineItem }) {
  const statusLabel = item.status === "completed" ? "完成" : item.status === "failed" ? "失败" : item.status === "in_progress" ? "执行中" : item.status === "pending" ? "等待" : "已更新";
  const fileTool = isFileToolKind(item.toolKind);
  return (
    <details className="tool-entry" data-status={item.status}>
      <summary><span className={`tool-status tool-status--${item.status}`}>{item.status === "completed" ? <CheckIcon size={13}/> : fileTool ? <FileIcon size={13}/> : <TerminalIcon size={13}/>}</span><span className="tool-entry__title"><strong>{item.title}</strong><small>{toolKindLabel(item.toolKind)} · {statusLabel}</small></span>{item.locations.length > 0 && <span className="tool-entry__count">{item.locations.length} 个位置</span>}<ChevronIcon className="summary-chevron" size={14}/></summary>
      <div className="tool-entry__details">{item.locations.length > 0 && <div className="tool-locations">{item.locations.map((location) => <span key={`${location.path}:${location.line ?? ""}`}><FileIcon size={13}/>{basename(location.path)}{location.line !== undefined ? `:${location.line}` : ""}</span>)}</div>}{item.output && <RichText compact text={item.output}/>} {(item.rawInput !== undefined || item.rawOutput !== undefined) && <details className="raw-details"><summary>更多详情</summary><pre>{summarizeRaw({ input: item.rawInput, output: item.rawOutput })}</pre></details>}</div>
    </details>
  );
}

function PlanEntry({ plan, note }: { plan: PlanEntryView[]; note: string | null }) {
  const completed = plan.filter((entry) => entry.status === "completed").length;
  return <div className="plan-timeline"><div><strong>执行计划</strong><span>{plan.length ? `${completed}/${plan.length} 已完成` : note ? "计划说明已更新" : "计划已更新"}</span></div>{plan.length > 0 && <div className="plan-mini">{plan.slice(0, 4).map((entry, index) => <span data-status={entry.status} key={`${entry.content}-${index}`}><i/>{entry.content}</span>)}</div>}{note && <div className="plan-timeline__note"><RichText compact text={note}/></div>}</div>;
}

function TurnStatusEntry({ presentation, detail }: {
  presentation: ReturnType<typeof turnOutcomePresentation>;
  detail: string | null;
}) {
  return <div className={`turn-status turn-status--${presentation.tone}`} role={presentation.tone === "error" ? "alert" : "status"}><strong>{presentation.label}</strong>{detail && <span>{detail}</span>}</div>;
}

function WorkingTail({ phase }: { phase: SessionExecutionPhase }) {
  const label = phase === "waiting_permission" ? "等待你的授权" : phase === "cancelling" ? "正在停止" : "Grok 正在执行";
  return <div aria-live="polite" className="working-tail" role="status"><span aria-hidden="true" className="working-tail__pulse"><i/><i/><i/></span><span>{label}</span></div>;
}

function Inspector({ currentView, tab, isOpen, onSelectTab, onClose, configBusyId, onChangeConfig, id }: {
  currentView?: SessionViewState;
  tab: InspectorTab;
  isOpen: boolean;
  onSelectTab(tab: InspectorTab): void;
  onClose(): void;
  configBusyId: string | null;
  onChangeConfig(configId: string, value: string | boolean): void;
  id?: string;
}) {
  const activity = currentView?.activity ?? [];
  const activityProjection = useMemo(() => projectVisibleActivity(activity), [activity]);
  const plan = currentView?.plan ?? [];
  const changes = currentView?.changes ?? [];
  const configOptions = currentView?.configOptions ?? [];
  return (
    <aside aria-hidden={!isOpen} className={`inspector${isOpen ? " is-open" : ""}`} aria-label="任务检查器" data-tab={tab} id={id}>
      <header><div><p>任务检查器</p><strong>{tab === "activity" ? "执行动态" : tab === "plan" ? "计划" : tab === "changes" ? "文件变化" : "ACP 配置"}</strong></div><button className="icon-button inspector-close" aria-label="关闭检查器" onClick={onClose} type="button"><CloseIcon size={17}/></button></header>
      <nav aria-label="检查器视图" role="tablist"><button aria-controls="inspector-panel" aria-selected={tab === "activity"} className={tab === "activity" ? "is-active" : ""} id="inspector-tab-activity" onClick={() => onSelectTab("activity")} role="tab" tabIndex={tab === "activity" ? 0 : -1} type="button">动态<span>{activityProjection.visible.length || ""}</span></button><button aria-controls="inspector-panel" aria-selected={tab === "plan"} className={tab === "plan" ? "is-active" : ""} id="inspector-tab-plan" onClick={() => onSelectTab("plan")} role="tab" tabIndex={tab === "plan" ? 0 : -1} type="button">计划<span>{plan.length || ""}</span></button><button aria-controls="inspector-panel" aria-selected={tab === "changes"} className={tab === "changes" ? "is-active" : ""} id="inspector-tab-changes" onClick={() => onSelectTab("changes")} role="tab" tabIndex={tab === "changes" ? 0 : -1} type="button">更改<span>{changes.length || ""}</span></button><button aria-controls="inspector-panel" aria-selected={tab === "config"} className={tab === "config" ? "is-active" : ""} id="inspector-tab-config" onClick={() => onSelectTab("config")} role="tab" tabIndex={tab === "config" ? 0 : -1} type="button">配置<span>{configOptions.length || ""}</span></button></nav>
      <div aria-labelledby={`inspector-tab-${tab}`} className="inspector__content" id="inspector-panel" role="tabpanel">{tab === "activity" && <ActivityPanel activity={activityProjection.visible} hiddenCount={activityProjection.hiddenCount}/>} {tab === "plan" && <PlanPanel note={currentView?.planNote ?? null} plan={plan}/>} {tab === "changes" && <ChangesPanel changes={changes}/>} {tab === "config" && <ConfigPanel busyId={configBusyId} onChange={onChangeConfig} options={configOptions}/>}</div>
    </aside>
  );
}

function ConfigPanel({ options, busyId, onChange }: { options: SessionConfigOption[]; busyId: string | null; onChange(configId: string, value: string | boolean): void }) {
  if (!options.length) return <InspectorEmpty body="Grok 未返回可编辑的 ACP 会话配置。" icon="activity" title="暂无会话配置"/>;
  return <div className="config-list">{options.map((option) => {
    const busy = busyId === option.id;
    return <section className={`config-row${option.readOnly ? " is-readonly" : ""}`} key={option.id}>
      <div className="config-row__heading"><strong>{option.name}</strong><span>{option.readOnly ? "只读" : "可编辑"}</span></div>
      {option.description && <p>{option.description}</p>}
      {option.type === "select" ? <select aria-label={option.name} disabled={option.readOnly || Boolean(busyId)} onChange={(event) => onChange(option.id, event.target.value)} value={String(option.currentValue)}>{(option.options ?? []).map((value) => <option key={value.value} value={value.value}>{value.name}</option>)}</select> : <button aria-pressed={option.currentValue === true} className="config-toggle" disabled={option.readOnly || Boolean(busyId)} onClick={() => onChange(option.id, !option.currentValue)} type="button"><span>{option.currentValue ? "已开启" : "已关闭"}</span><i className={option.currentValue ? "is-on" : ""}><b/></i></button>}
      {busy && <small className="config-row__busy">正在更新…</small>}
      {option.readOnly && <small className="config-row__hint">Grok 当前版本只提供状态，不支持通过 ACP 切换。</small>}
    </section>;
  })}</div>;
}

function InspectorEmpty({ icon, title, body }: { icon: "activity" | "plan" | "changes"; title: string; body: string }) {
  return <div className="inspector-empty">{icon === "changes" ? <FileIcon/> : icon === "plan" ? <CheckIcon/> : <SparkIcon/>}<strong>{title}</strong><p>{body}</p></div>;
}

function ActivityPanel({ activity, hiddenCount }: { activity: ActivityRecord[]; hiddenCount: number }) {
  if (!activity.length) return <div className="activity-empty"><InspectorEmpty body="工具、模式变化、错误和未知事件会显示在这里；消息正文与计划留在各自的主视图。" icon="activity" title="没有需要关注的动态"/>{hiddenCount > 0 && <ActivityFilterNote count={hiddenCount}/>}</div>;
  return <div className="activity-list">{[...activity].reverse().map((entry) => <details className={`activity-row${entry.unknown ? " is-unknown" : ""}`} key={entry.id}><summary><span className={`activity-dot${entry.status ? ` activity-dot--${entry.status}` : ""}`}/><span><strong>{entry.label}</strong><small>{entry.detail}</small></span><time>{formatClock(entry.receivedAt)}</time></summary><pre>{summarizeRaw(entry.raw)}</pre></details>)}{hiddenCount > 0 && <ActivityFilterNote count={hiddenCount}/>}</div>;
}

function ActivityFilterNote({ count }: { count: number }) {
  return <div className="activity-filter-note"><SparkIcon size={13}/><span>已收起 {count} 条消息流、计划或配置同步事件</span></div>;
}

function PlanPanel({ plan, note }: { plan: PlanEntryView[]; note: string | null }) {
  if (!plan.length && !note) return <InspectorEmpty body="当 Grok 发布结构化计划时，这里会同步每一步的进度。" icon="plan" title="暂时没有计划"/>;
  return <div className="inspector-plan">{plan.map((entry, index) => <div className="inspector-plan__row" data-status={entry.status} key={`${entry.content}-${index}`}><span>{entry.status === "completed" ? <CheckIcon size={13}/> : index + 1}</span><div><strong>{entry.content}</strong><small>{entry.status === "completed" ? "已完成" : entry.status === "in_progress" ? "进行中" : "等待"} · {entry.priority}</small></div></div>)}{note && <div className="plan-note"><RichText compact text={note}/></div>}</div>;
}

function ChangesPanel({ changes }: { changes: ChangeRecord[] }) {
  if (!changes.length) return <InspectorEmpty body="ACP 返回文件差异后，会在这里按文件汇总。" icon="changes" title="还没有文件更改"/>;
  return <div className="changes-list">{changes.map((change) => <ChangeReview change={change} key={change.path}/>)}</div>;
}

const INITIAL_DIFF_RENDER_LINE_COUNT = 360;

function ChangeReview({ change }: { change: ChangeRecord }) {
  const review = useMemo(() => {
    const diff = createLineDiff(change);
    return {
      hunks: createDiffHunks(diff),
      stats: lineStatsFromDiff(diff),
    };
  }, [change]);
  const fileStatus = change.oldText === null ? "新增" : change.newText.length === 0 ? "删除" : "修改";
  return (
    <details className="change-row">
      <summary>
        <FileIcon size={15}/>
        <span><strong>{basename(change.path)}</strong><small title={change.path}>{fileStatus} · {change.path}</small></span>
        <em><b>+{review.stats.added}</b><i>−{review.stats.removed}</i></em>
        <ChevronIcon size={13}/>
      </summary>
      <ChangeDiff hunks={review.hunks}/>
    </details>
  );
}

function ChangeDiff({ hunks }: { hunks: DiffHunk[] }) {
  const [showAll, setShowAll] = useState(false);
  useEffect(() => setShowAll(false), [hunks]);
  if (!hunks.length) return <div className="change-diff-empty">文件内容没有可见变化。</div>;

  const hidden = countHiddenDiffLines(hunks, INITIAL_DIFF_RENDER_LINE_COUNT);
  const hasHiddenLines = hidden.changed + hidden.context > 0;
  const visibleHunks = showAll || !hasHiddenLines
    ? hunks
    : limitDiffHunks(hunks, INITIAL_DIFF_RENDER_LINE_COUNT);
  const trailingContext = hunks.at(-1)?.omittedAfter ?? 0;
  return (
    <div className="change-diff">
      {visibleHunks.map((hunk, hunkIndex) => (
        <section className="diff-hunk" key={`${hunk.oldStart}-${hunk.newStart}-${hunkIndex}`}>
          <div className="diff-hunk__header">
            <code>@@ -{hunk.oldStart},{hunk.oldCount} +{hunk.newStart},{hunk.newCount} @@</code>
            {hunk.omittedBefore > 0 && <span>折叠 {hunk.omittedBefore.toLocaleString()} 行未修改内容</span>}
          </div>
          <pre>{hunk.lines.map((line, lineIndex) => <span className={`diff-line diff-line--${line.kind}`} key={`${line.kind}-${line.oldLine ?? ""}-${line.newLine ?? ""}-${lineIndex}`}><i>{line.oldLine ?? ""}</i><i>{line.newLine ?? ""}</i><b>{line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}</b><code>{line.text || " "}</code></span>)}</pre>
        </section>
      ))}
      {!showAll && hasHiddenLines && (
        <button aria-expanded="false" className="change-diff__more" onClick={() => setShowAll(true)} type="button">
          <span>显示完整差异</span>
          <small>还有 {hidden.changed.toLocaleString()} 个变更行和 {hidden.context.toLocaleString()} 行上下文</small>
        </button>
      )}
      {(showAll || !hasHiddenLines) && trailingContext > 0 && <div className="diff-hunk__tail">折叠 {trailingContext.toLocaleString()} 行未修改内容</div>}
    </div>
  );
}

function limitDiffHunks(hunks: readonly DiffHunk[], maximumLines: number): DiffHunk[] {
  const limited: DiffHunk[] = [];
  let remaining = maximumLines;
  for (const hunk of hunks) {
    if (remaining <= 0) break;
    const lines = hunk.lines.slice(0, remaining);
    limited.push({
      ...hunk,
      lines,
      oldCount: lines.reduce((count, line) => count + (line.oldLine === null ? 0 : 1), 0),
      newCount: lines.reduce((count, line) => count + (line.newLine === null ? 0 : 1), 0),
      omittedAfter: 0,
    });
    remaining -= lines.length;
  }
  return limited;
}

function countHiddenDiffLines(
  hunks: readonly DiffHunk[],
  visibleLineCount: number,
): { changed: number; context: number } {
  let remainingVisible = visibleLineCount;
  let changed = 0;
  let context = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (remainingVisible > 0) {
        remainingVisible -= 1;
      } else if (line.kind === "context") {
        context += 1;
      } else {
        changed += 1;
      }
    }
  }
  return { changed, context };
}

interface SettingsModalProps {
  bootstrap: BootstrapPayload;
  connectionBusy: boolean;
  installation: GrokInstallation | null;
  modelCatalog: ModelInfo[];
  enabledModelIds: string[];
  runtime: RuntimeSnapshot;
  taskBusy: boolean;
  permissionMode: PermissionModePreference;
  themePreference: ThemePreference;
  storedXaiCredential: XaiCredentialStatus;
  xaiApiBaseUrl: string;
  xaiApiKey: string;
  mcpServers: McpServerConfig[];
  workspacePath: string | null;
  onChooseExecutable(): void;
  onClearStoredXaiApiKey(): Promise<boolean>;
  onChangeTheme(themePreference: ThemePreference): Promise<boolean>;
  onDisconnect(): void;
  onApplyConnectionSettings(
    workspacePath: string | null,
    settings: ConnectionSettingsDraft,
  ): Promise<boolean>;
  onClose(): void;
}

function SettingsModal({
  bootstrap,
  connectionBusy,
  installation,
  modelCatalog,
  enabledModelIds,
  runtime,
  taskBusy,
  permissionMode,
  themePreference,
  storedXaiCredential,
  xaiApiBaseUrl,
  xaiApiKey,
  mcpServers,
  workspacePath,
  onChooseExecutable,
  onClearStoredXaiApiKey,
  onChangeTheme,
  onDisconnect,
  onApplyConnectionSettings,
  onClose,
}: SettingsModalProps) {
  const dialogRef = useDialogFocus<HTMLElement>("settings");
  const [draftBaseUrl, setDraftBaseUrl] = useState(xaiApiBaseUrl);
  const [draftApiKey, setDraftApiKey] = useState(xaiApiKey);
  const initialModels = modelCatalog.length > 0 ? modelCatalog : runtime.availableModels;
  const [draftModels, setDraftModels] = useState<ModelInfo[]>(() =>
    initialModels.map((model) => ({ ...model })),
  );
  const [draftEnabledModelIds, setDraftEnabledModelIds] = useState<string[]>(() => {
    const available = new Set(initialModels.map((model) => model.id));
    const retained = enabledModelIds.filter((modelId) => available.has(modelId));
    return retained.length > 0 ? retained : initialModels.map((model) => model.id);
  });
  const [modelDiscoveryPhase, setModelDiscoveryPhase] = useState<ModelDiscoveryPhase>(
    initialModels.length > 0 ? "ready" : "idle",
  );
  const [modelDiscoveryMessage, setModelDiscoveryMessage] = useState<string | null>(null);
  const modelDiscoveryRevision = useRef(0);
  const [draftPermissionMode, setDraftPermissionMode] = useState(permissionMode);
  const [draftMcpServers, setDraftMcpServers] = useState<EditableMcpServer[]>(
    () => createEditableMcpServers(mcpServers),
  );
  const [stdioExecutionConfirmed, setStdioExecutionConfirmed] = useState(false);
  const [mcpPickerError, setMcpPickerError] = useState<string | null>(null);
  const [apiKeyScope, setApiKeyScope] = useState<string | null | undefined>(
    () => getXaiApiCredentialScope(xaiApiBaseUrl),
  );
  const [apiKeyClearedForEndpointChange, setApiKeyClearedForEndpointChange] = useState(false);
  const [draftModelId, setDraftModelId] = useState(() =>
    runtime.currentModelId && initialModels.some(
      (model) => model.id === runtime.currentModelId,
    )
      ? runtime.currentModelId
      : "",
  );
  const [draftReasoningEffort, setDraftReasoningEffort] = useState(() =>
    preferredReasoningEffort(initialModels, runtime.currentModelId),
  );
  const [showApiKey, setShowApiKey] = useState(false);
  const [themeBusy, setThemeBusy] = useState(false);
  const [credentialBusy, setCredentialBusy] = useState(false);
  const baseUrlError = validateXaiApiBaseUrl(draftBaseUrl);
  const baseUrlAdvisory = baseUrlError ? null : xaiApiBaseUrlAdvisory(draftBaseUrl);
  const storedCredentialAvailable = canUseStoredXaiCredential(
    draftBaseUrl,
    storedXaiCredential,
  );
  const connectionPairError = validateXaiConnectionPair(
    draftBaseUrl,
    draftApiKey,
    storedCredentialAvailable,
  );
  const capabilitiesAuthoritative = runtimeCapabilitiesApplyToExecutable(
    runtime,
    installation?.executablePath,
  );
  const mcpValidationError = mcpSettingsError(
    draftMcpServers,
    runtime,
    capabilitiesAuthoritative,
  );
  const mcpConfigError = !workspacePath && draftMcpServers.length > 0
    ? "请先选择工作区，再配置 MCP 服务器。"
    : mcpValidationError;
  const hasStdioServer = draftMcpServers.some((server) => server.type === "stdio");
  const stdioServerCount = draftMcpServers.filter((server) => server.type === "stdio").length;
  const stdioConfirmationMissing = hasStdioServer && !stdioExecutionConfirmed;
  const hasUnrestoredMcp = hasUnrestoredMcpConfiguration(
    runtime,
    mcpServers,
    workspacePath,
    bootstrap.platform,
  );
  const showReportedMcpStatus = runtime.reportedMcpServerCount > 0 &&
    runtimeMcpStatusAppliesToWorkspace(runtime, workspacePath, bootstrap.platform);
  const apiKeyHelp = xaiApiKeyHelpText(draftBaseUrl);
  const hasWorkspace = Boolean(workspacePath);
  const reconnectBlocked = hasWorkspace && taskBusy;
  const disconnectControl = settingsDisconnectControl(runtime, taskBusy);
  const availableMcpTransports = capabilitiesAuthoritative
    ? MCP_TRANSPORTS.filter((transport) => runtime.capabilities.mcp[transport])
    : [...MCP_TRANSPORTS];
  const selectedReasoningEfforts = useMemo(
    () => reasoningEffortsForModel(draftModels, draftModelId || null),
    [draftModelId, draftModels],
  );
  const selectedReasoningEffort = selectedReasoningEfforts.find(
    (effort) => effort.id === draftReasoningEffort,
  );
  const currentApiKeyScope = getXaiApiCredentialScope(draftBaseUrl);
  const apiKeyTargetInvalid = currentApiKeyScope === undefined || currentApiKeyScope === null;
  const enabledModels = selectEnabledModels(draftModels, draftEnabledModelIds);
  const modelSelectionInvalid = enabledModels.length === 0 ||
    !enabledModels.some((model) => model.id === draftModelId);
  const apiKeyReentryRequired = requiresXaiApiKeyReentry(
    runtime,
    draftBaseUrl,
    draftApiKey,
    storedCredentialAvailable,
  );
  const apiKeyDescription = [
    "xai-api-key-help",
    draftApiKey ? "xai-api-key-cli-mcp-notice" : null,
    apiKeyTargetInvalid ? "xai-api-key-target-notice" : null,
    apiKeyClearedForEndpointChange ? "xai-api-key-scope-notice" : null,
    storedCredentialAvailable && !draftApiKey ? "xai-api-key-stored-notice" : null,
    storedXaiCredential.available && !storedCredentialAvailable
      ? "xai-api-key-other-scope-notice"
      : null,
    apiKeyReentryRequired ? "xai-api-key-reentry-notice" : null,
  ].filter(Boolean).join(" ");

  useEffect(() => {
    setDraftModelId((current) => {
      if (draftModels.some((model) => model.id === current)) {
        return current;
      }
      return runtime.currentModelId && draftModels.some(
        (model) => model.id === runtime.currentModelId,
      )
        ? runtime.currentModelId
        : draftModels[0]?.id ?? "";
    });
  }, [draftModels, runtime.currentModelId]);

  useEffect(() => {
    setDraftReasoningEffort((current) => current === "" || selectedReasoningEfforts.some(
      (effort) => effort.id === current,
    )
      ? current
      : preferredReasoningEffort(draftModels, draftModelId || null));
  }, [draftModelId, draftModels, selectedReasoningEfforts]);

  useEffect(() => {
    const hideSecrets = () => {
      setShowApiKey(false);
      setDraftMcpServers((servers) => servers.map((server) => {
        if (server.type === "stdio") {
          return server.showEnvironmentValues
            ? { ...server, showEnvironmentValues: false }
            : server;
        }
        return server.showHeaderValues
          ? { ...server, showHeaderValues: false }
          : server;
      }));
    };
    window.addEventListener("blur", hideSecrets);
    return () => window.removeEventListener("blur", hideSecrets);
  }, []);

  const invalidateDiscoveredModels = () => {
    modelDiscoveryRevision.current += 1;
    setDraftModels([]);
    setDraftEnabledModelIds([]);
    setDraftModelId("");
    setDraftReasoningEffort("");
    setModelDiscoveryPhase("idle");
    setModelDiscoveryMessage(null);
  };

  const changeBaseUrl = (nextBaseUrl: string) => {
    const transition = transitionXaiApiKeyForBaseUrl(
      draftApiKey,
      apiKeyScope,
      nextBaseUrl,
    );
    setDraftBaseUrl(nextBaseUrl);
    setDraftApiKey(transition.apiKey);
    setApiKeyScope(transition.apiKeyScope);
    invalidateDiscoveredModels();
    if (transition.cleared) {
      setShowApiKey(false);
      setApiKeyClearedForEndpointChange(true);
    }
  };

  const changeApiKey = (nextApiKey: string) => {
    setDraftApiKey(nextApiKey);
    setApiKeyScope(getXaiApiCredentialScope(draftBaseUrl));
    setApiKeyClearedForEndpointChange(false);
    if (!nextApiKey) setShowApiKey(false);
    invalidateDiscoveredModels();
  };

  const discoverModels = async () => {
    const validationError = validateXaiConnectionPair(
      draftBaseUrl,
      draftApiKey,
      storedCredentialAvailable,
    );
    if (validationError || !workspacePath || !installation?.executablePath || connectionBusy) {
      setModelDiscoveryPhase("error");
      setModelDiscoveryMessage(
        validationError ?? (!workspacePath
          ? "请先选择工作区，再检测地址和获取模型。"
          : "未找到可用的 Grok CLI。"),
      );
      return;
    }

    const revision = ++modelDiscoveryRevision.current;
    setModelDiscoveryPhase("loading");
    setModelDiscoveryMessage("正在通过 Grok ACP 检测同源 API 路径并获取模型…");
    try {
      const result = await window.grokDesktop.discoverModels({
        workspacePath,
        executablePath: installation.executablePath,
        xaiApiBaseUrl: normalizeXaiApiBaseUrl(draftBaseUrl),
        ...(draftApiKey.trim()
          ? { xaiApiKey: normalizeXaiApiKey(draftApiKey) }
          : { useStoredXaiApiKey: true as const }),
      });
      if (revision !== modelDiscoveryRevision.current) return;
      const models = result.models.map((model) => ({ ...model }));
      if (models.length === 0) {
        setDraftModels([]);
        setDraftEnabledModelIds([]);
        setDraftModelId("");
        setModelDiscoveryPhase("error");
        setModelDiscoveryMessage("地址已通过 ACP 初始化，但 Grok 没有返回可用模型。");
        return;
      }
      const selectedModelId = result.currentModelId && models.some(
        (model) => model.id === result.currentModelId,
      )
        ? result.currentModelId
        : models[0]!.id;
      setDraftBaseUrl(result.resolvedBaseUrl);
      setApiKeyScope(getXaiApiCredentialScope(result.resolvedBaseUrl));
      setApiKeyClearedForEndpointChange(false);
      setDraftModels(models);
      setDraftEnabledModelIds(models.map((model) => model.id));
      setDraftModelId(selectedModelId);
      setDraftReasoningEffort(preferredReasoningEffort(models, selectedModelId));
      setModelDiscoveryPhase("ready");
      setModelDiscoveryMessage(`已匹配 ${result.resolvedBaseUrl}，获取 ${models.length} 个模型。`);
    } catch (error) {
      if (revision !== modelDiscoveryRevision.current) return;
      setDraftModels([]);
      setDraftEnabledModelIds([]);
      setDraftModelId("");
      setModelDiscoveryPhase("error");
      setModelDiscoveryMessage(redactSensitiveText(
        userFacingErrorMessage(error, "地址检测或模型获取失败"),
        draftApiKey,
      ));
    }
  };

  const toggleModelEnabled = (modelId: string, enabled: boolean) => {
    const next = enabled
      ? [...new Set([...draftEnabledModelIds, modelId])]
      : draftEnabledModelIds.filter((candidate) => candidate !== modelId);
    setDraftEnabledModelIds(next);
    if (!next.includes(draftModelId)) {
      setDraftModelId(draftModels.find((model) => next.includes(model.id))?.id ?? "");
      setDraftReasoningEffort("");
    }
  };

  const updateMcpServer = (
    serverIndex: number,
    update: (server: EditableMcpServer) => EditableMcpServer,
  ) => {
    setDraftMcpServers((servers) => servers.map((server, index) =>
      index === serverIndex ? update(server) : server,
    ));
  };

  const changeMcpServerUrl = (serverIndex: number, nextUrl: string) => {
    updateMcpServer(serverIndex, (server) => {
      if (server.type === "stdio") return server;
      const targetReady = getMcpServerCredentialScope(nextUrl) !== undefined;
      const transition = transitionMcpHeadersForUrl(
        server.headers,
        server.headerScope,
        nextUrl,
      );
      return {
        ...server,
        url: nextUrl,
        headers: transition.headers,
        headerScope: transition.headerScope,
        headersClearedForEndpointChange:
          server.headersClearedForEndpointChange || transition.cleared,
        showHeaderValues: transition.cleared || !targetReady ? false : server.showHeaderValues,
      };
    });
  };

  const updateMcpHeader = (
    serverIndex: number,
    headerIndex: number,
    field: keyof McpHttpHeader,
    value: string,
  ) => {
    updateMcpServer(serverIndex, (server) => server.type === "stdio"
      ? server
      : {
          ...server,
          headers: server.headers.map((header, index) =>
            index === headerIndex ? { ...header, [field]: value } : header,
          ),
          headerScope: getMcpServerCredentialScope(server.url),
          headersClearedForEndpointChange: false,
        });
  };

  const changeMcpServerTransport = (serverIndex: number, type: McpTransport) => {
    setStdioExecutionConfirmed(false);
    updateMcpServer(serverIndex, (server) => server.type === type
      ? server
      : { ...createEmptyEditableMcpServer(type), editorId: server.editorId, name: server.name });
  };

  const addMcpServer = () => {
    const type = availableMcpTransports[0];
    if (!type || draftMcpServers.length >= MAX_MCP_SERVERS) return;
    if (type === "stdio") setStdioExecutionConfirmed(false);
    setDraftMcpServers((servers) => [...servers, createEmptyEditableMcpServer(type)]);
  };

  const removeMcpServer = (serverIndex: number) => {
    setDraftMcpServers((servers) => servers.filter((_, index) => index !== serverIndex));
  };

  const addMcpHeader = (serverIndex: number) => {
    updateMcpServer(serverIndex, (server) => server.type === "stdio" || server.headers.length >= MAX_MCP_HEADERS_PER_SERVER
      ? server
      : {
          ...server,
          headers: [...server.headers, { name: "", value: "" }],
          headerScope: getMcpServerCredentialScope(server.url),
          headersClearedForEndpointChange: false,
        });
  };

  const removeMcpHeader = (serverIndex: number, headerIndex: number) => {
    updateMcpServer(serverIndex, (server) => server.type === "stdio"
      ? server
      : {
          ...server,
          headers: server.headers.filter((_, index) => index !== headerIndex),
          headersClearedForEndpointChange: false,
        });
  };

  const chooseMcpExecutable = async (serverIndex: number) => {
    if (connectionBusy) return;
    try {
      setMcpPickerError(null);
      const command = await window.grokDesktop.chooseMcpExecutable();
      if (!command) return;
      setStdioExecutionConfirmed(false);
      updateMcpServer(serverIndex, (server) => server.type === "stdio"
        ? { ...server, command }
        : server);
    } catch (error) {
      setMcpPickerError(userFacingErrorMessage(error, "无法选择 MCP 可执行文件"));
    }
  };

  const addMcpArgument = (serverIndex: number) => {
    setStdioExecutionConfirmed(false);
    updateMcpServer(serverIndex, (server) => server.type !== "stdio" || server.args.length >= MAX_MCP_STDIO_ARGUMENTS_PER_SERVER
      ? server
      : { ...server, args: [...server.args, ""] });
  };

  const updateMcpArgument = (serverIndex: number, argumentIndex: number, value: string) => {
    setStdioExecutionConfirmed(false);
    updateMcpServer(serverIndex, (server) => server.type !== "stdio"
      ? server
      : { ...server, args: server.args.map((argument, index) => index === argumentIndex ? value : argument) });
  };

  const removeMcpArgument = (serverIndex: number, argumentIndex: number) => {
    setStdioExecutionConfirmed(false);
    updateMcpServer(serverIndex, (server) => server.type !== "stdio"
      ? server
      : { ...server, args: server.args.filter((_, index) => index !== argumentIndex) });
  };

  const addMcpEnvironmentVariable = (serverIndex: number) => {
    setStdioExecutionConfirmed(false);
    updateMcpServer(serverIndex, (server) => server.type !== "stdio" || server.env.length >= MAX_MCP_STDIO_ENV_PER_SERVER
      ? server
      : { ...server, env: [...server.env, { name: "", value: "" }] });
  };

  const updateMcpEnvironmentVariable = (
    serverIndex: number,
    variableIndex: number,
    field: keyof McpStdioEnvironmentVariable,
    value: string,
  ) => {
    setStdioExecutionConfirmed(false);
    updateMcpServer(serverIndex, (server) => server.type !== "stdio"
      ? server
      : {
          ...server,
          env: server.env.map((variable, index) =>
            index === variableIndex ? { ...variable, [field]: value } : variable,
          ),
        });
  };

  const removeMcpEnvironmentVariable = (serverIndex: number, variableIndex: number) => {
    setStdioExecutionConfirmed(false);
    updateMcpServer(serverIndex, (server) => server.type !== "stdio"
      ? server
      : { ...server, env: server.env.filter((_, index) => index !== variableIndex) });
  };

  const applySettings = async () => {
    if (
      connectionPairError ||
      apiKeyReentryRequired ||
      modelDiscoveryPhase !== "ready" ||
      modelSelectionInvalid ||
      mcpConfigError ||
      stdioConfirmationMissing ||
      connectionBusy
    ) return;
    const applied = await onApplyConnectionSettings(workspacePath, {
        baseUrl: draftBaseUrl,
        apiKey: draftApiKey,
        models: draftModels,
        enabledModelIds: draftEnabledModelIds,
        permissionMode: draftPermissionMode,
        modelId: draftModelId || null,
        reasoningEffort: draftReasoningEffort || null,
        mcpServers: normalizeMcpServers(draftMcpServers),
        allowStdioMcpExecution: stdioExecutionConfirmed,
    });
    if (applied) onClose();
  };

  const changeThemePreference = async (nextTheme: ThemePreference) => {
    if (themeBusy || nextTheme === themePreference) return;
    setThemeBusy(true);
    try {
      await onChangeTheme(nextTheme);
    } finally {
      setThemeBusy(false);
    }
  };

  const clearApiKey = async () => {
    if (credentialBusy) return;
    if (draftApiKey) changeApiKey("");
    if (!storedXaiCredential.available) return;
    setCredentialBusy(true);
    try {
      await onClearStoredXaiApiKey();
    } finally {
      setCredentialBusy(false);
    }
  };

  const requestClose = () => {
    if (!connectionBusy) onClose();
  };

  const baseUrlDescription = [
    "xai-api-base-url-help",
    baseUrlError ? "xai-api-base-url-error" : null,
    baseUrlAdvisory ? "xai-api-base-url-advisory" : null,
  ].filter(Boolean).join(" ");
  return (
    <div className="modal-layer settings-layer" role="presentation">
      <section aria-labelledby="settings-title" aria-modal="true" className="modal settings-modal" ref={dialogRef} role="dialog" tabIndex={-1}>
        <header>
          <div><p className="eyebrow">Grok Desktop</p><h2 id="settings-title">设置</h2><span>管理外观、本地运行时、xAI 连接、MCP 和授权策略。</span></div>
          <button className="icon-button" aria-label="关闭设置" disabled={connectionBusy} onClick={requestClose} type="button"><CloseIcon/></button>
        </header>

        <div className="settings-scroll">
          <section className="settings-group" aria-labelledby="appearance-settings-title">
            <div className="settings-group__heading"><h3 id="appearance-settings-title">外观</h3><p>主题会同步应用到工作台、弹窗和 Windows 标题栏。</p></div>
            <div aria-label="应用外观" className="appearance-settings" role="radiogroup">
              {THEME_OPTIONS.map((option) => (
                <button
                  aria-checked={themePreference === option.id}
                  className={themePreference === option.id ? "is-selected" : ""}
                  disabled={themeBusy}
                  key={option.id}
                  onClick={() => void changeThemePreference(option.id)}
                  role="radio"
                  type="button"
                >
                  <span aria-hidden="true" className={`theme-swatch theme-swatch--${option.id}`}><i/><b/></span>
                  <span><strong>{option.label}</strong><small>{option.description}</small></span>
                </button>
              ))}
            </div>
          </section>

          <section className="settings-group" aria-labelledby="runtime-settings-title">
            <div className="settings-group__heading"><h3 id="runtime-settings-title">本地运行时</h3><p>桌面端直接启动你电脑上现有的 Grok CLI。</p></div>
            <div className="executable-row">
              <span className={installation?.found ? "is-ok" : "is-error"}><TerminalIcon size={17}/></span>
              <div><strong>{installation?.found ? "已找到 Grok" : "尚未配置"}</strong><small>{installation?.executablePath || installation?.error || "请选择 grok.exe"}</small></div>
              <button className="subtle-button" disabled={connectionBusy} onClick={onChooseExecutable} type="button">更改</button>
            </div>
          </section>

          <section className="settings-group" aria-labelledby="connection-settings-title">
            <div className="settings-group__heading"><h3 id="connection-settings-title">API 连接</h3><p>结构化连接只使用用户明确提供的 URL + API Key。连接成功后，Key 由当前用户的系统安全凭据库加密保存。</p></div>
            <div className="settings-field">
              <label htmlFor="xai-api-base-url">API Base URL</label>
              <input
                aria-describedby={baseUrlDescription}
                aria-invalid={Boolean(baseUrlError)}
                autoCapitalize="none"
                autoComplete="off"
                disabled={connectionBusy}
                id="xai-api-base-url"
                inputMode="url"
                maxLength={MAX_XAI_API_BASE_URL_LENGTH}
                onChange={(event) => changeBaseUrl(event.target.value)}
                placeholder="输入兼容 API Base URL"
                spellCheck={false}
                type="text"
                value={draftBaseUrl}
              />
              <small id="xai-api-base-url-help">可以输入任意兼容服务商地址。检测只在相同 Origin 内尝试候选 API 路径；成功连接后保存解析出的 URL。</small>
              {baseUrlError && <small className="settings-field__error" id="xai-api-base-url-error" role="status">{baseUrlError}</small>}
              {baseUrlAdvisory && <small className="settings-field__notice" id="xai-api-base-url-advisory" role="note">{baseUrlAdvisory}</small>}
            </div>

            <div className="settings-field">
              <label htmlFor="xai-api-key">API Key</label>
              <div className="secret-input-row">
                <input
                  aria-describedby={apiKeyDescription}
                  autoCapitalize="none"
                  autoComplete="new-password"
                  disabled={connectionBusy || credentialBusy || apiKeyTargetInvalid}
                  id="xai-api-key"
                  maxLength={MAX_XAI_API_KEY_LENGTH}
                  onChange={(event) => changeApiKey(event.target.value)}
                  placeholder={storedCredentialAvailable
                    ? "已使用本机安全保存的 API Key"
                    : "输入 API Key"}
                  spellCheck={false}
                  type={showApiKey ? "text" : "password"}
                  value={draftApiKey}
                />
                <button aria-label={showApiKey ? "隐藏 API Key" : "显示 API Key"} aria-pressed={showApiKey} disabled={connectionBusy || credentialBusy || apiKeyTargetInvalid || !draftApiKey} onClick={() => setShowApiKey((visible) => !visible)} type="button">{showApiKey ? "隐藏" : "显示"}</button>
                <button
                  aria-label={storedXaiCredential.available
                    ? "清除输入并删除本机保存的 API Key"
                    : "清除输入的 API Key"}
                  disabled={connectionBusy || credentialBusy || (!draftApiKey && !storedXaiCredential.available)}
                  onClick={() => void clearApiKey()}
                  type="button"
                >{credentialBusy ? "清除中…" : storedXaiCredential.available ? "清除本机 Key" : "清除输入"}</button>
              </div>
              <small id="xai-api-key-help">{apiKeyHelp}</small>
              {draftApiKey && <small className="settings-field__notice" id="xai-api-key-cli-mcp-notice" role="note">桌面端只隔离本页注入的 stdio MCP；Grok CLI 自行管理的 MCP 属于外部 Grok 配置，可能继承 Grok 进程环境中的本次 Key。</small>}
              {storedCredentialAvailable && !draftApiKey && <small className="settings-field__notice" id="xai-api-key-stored-notice" role="status">已找到由当前系统用户安全保存、并与此 API Origin 匹配的 Key。明文不会显示或返回 Renderer。</small>}
              {storedXaiCredential.available && !storedCredentialAvailable && <small className="settings-field__notice" id="xai-api-key-other-scope-notice" role="status">本机保存的 Key 绑定到 {storedXaiCredential.scope}，不能用于当前 API 地址。</small>}
              {!storedXaiCredential.secureStorageAvailable && <small className="settings-field__notice" role="status">当前系统安全凭据存储不可用；Key 只会保留到应用退出。</small>}
              {apiKeyTargetInvalid && <small className="settings-field__notice" id="xai-api-key-target-notice" role="status">先输入有效的 API Base URL，再绑定 API Key。</small>}
              {apiKeyClearedForEndpointChange && <small className="settings-field__notice" id="xai-api-key-scope-notice" role="status">旧 API Key 已从设置草稿移除；应用并重新连接后将停止使用原凭据。</small>}
              {apiKeyReentryRequired && <small className="settings-field__notice" id="xai-api-key-reentry-notice" role="status">当前 Grok 连接仍在使用未保存到系统安全凭据库的 API Key。重新连接前必须再次输入。</small>}
            </div>

            <div className="model-discovery-actions">
              <button
                aria-busy={modelDiscoveryPhase === "loading"}
                className="subtle-button"
                disabled={Boolean(connectionPairError) || !workspacePath || !installation?.executablePath || connectionBusy || modelDiscoveryPhase === "loading"}
                onClick={() => void discoverModels()}
                type="button"
              >
                {modelDiscoveryPhase === "loading" ? "正在检测…" : "检测地址并获取模型"}
              </button>
              <small>不会读取外部 CLI 身份状态；Key 仅在 Main 解密后传给短生命周期 ACP 进程。</small>
            </div>
            {modelDiscoveryMessage && (
              <div
                aria-live="polite"
                className={`model-discovery-status is-${modelDiscoveryPhase}`}
                id="model-discovery-status"
                role={modelDiscoveryPhase === "error" ? "alert" : "status"}
              >
                {modelDiscoveryMessage}
              </div>
            )}
          </section>

          <section className="settings-group model-settings" aria-labelledby="model-settings-title">
            <div className="settings-group__heading"><h3 id="model-settings-title">可用模型</h3><p>模型来自当前 URL + Key 对应的 Grok ACP 响应。可以同时启用多个模型，并选择本次连接的初始模型。</p></div>
            {draftModels.length === 0 ? (
              <div className="model-settings__empty">
                <strong>尚未获取模型</strong>
                <span>先完成上方 URL 与 Key，再点击“检测地址并获取模型”。</span>
              </div>
            ) : (
              <>
                <div aria-label="启用的模型" className="model-catalog">
                  {draftModels.map((model) => {
                    const enabled = draftEnabledModelIds.includes(model.id);
                    return (
                      <label className={`model-catalog__item${enabled ? " is-enabled" : ""}`} key={model.id}>
                        <input checked={enabled} disabled={connectionBusy || taskBusy} onChange={(event) => toggleModelEnabled(model.id, event.target.checked)} type="checkbox"/>
                        <span><strong>{model.name}</strong><small>{model.id}</small>{model.description && <em>{model.description}</em>}</span>
                      </label>
                    );
                  })}
                </div>
                <div className="settings-field">
                  <label htmlFor="grok-model">初始模型</label>
                  <select
                    disabled={taskBusy || connectionBusy || enabledModels.length === 0}
                    id="grok-model"
                    onChange={(event) => {
                      const nextModelId = event.target.value;
                      setDraftModelId(nextModelId);
                      setDraftReasoningEffort(preferredReasoningEffort(draftModels, nextModelId));
                    }}
                    value={draftModelId}
                  >
                    {enabledModels.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
                  </select>
                  <small>应用时会先用同一连接重新验证模型，再把选择通过 Grok 的 `--model` 参数应用。</small>
                </div>
                {selectedReasoningEfforts.length > 0 && (
                  <div className="settings-field">
                    <label htmlFor="grok-reasoning-effort">思考强度</label>
                    <select disabled={taskBusy || connectionBusy} id="grok-reasoning-effort" onChange={(event) => setDraftReasoningEffort(event.target.value)} value={draftReasoningEffort}>
                      <option value="">使用模型默认思考强度</option>
                      {selectedReasoningEfforts.map((effort) => <option key={effort.id} value={effort.id}>{effort.name}</option>)}
                    </select>
                    <small>{selectedReasoningEffort?.description ?? "仅显示 Grok ACP 为当前模型广告的档位。"}</small>
                  </div>
                )}
              </>
            )}
          </section>

          <section
            aria-describedby={[
              mcpConfigError ? "mcp-settings-error" : null,
              stdioConfirmationMissing ? "mcp-stdio-confirmation" : null,
            ].filter(Boolean).join(" ") || undefined}
            aria-labelledby="mcp-settings-title"
            className="settings-group mcp-settings"
          >
              <div className="settings-group__heading mcp-settings__heading">
                <div>
                  <h3 id="mcp-settings-title">MCP 服务器</h3>
                  <p>每个工作区独立配置。应用并重新连接后生效，退出桌面端后清除。</p>
                </div>
                <div className="mcp-transport-flags" aria-label="MCP 传输能力状态">
                  {capabilitiesAuthoritative
                    ? availableMcpTransports.length > 0
                      ? availableMcpTransports.map((transport) => <span key={transport}>{transport.toUpperCase()}</span>)
                      : <span className="is-unavailable">当前未广告可用 MCP 传输</span>
                    : <span className="is-pending">连接后验证</span>}
                </div>
              </div>

              <div className={`mcp-settings__scope${workspacePath ? "" : " is-empty"}`}>
                <FolderIcon size={15}/>
                <div><strong>{workspacePath ? basename(workspacePath) : "尚未选择工作区"}</strong><span title={workspacePath ?? undefined}>{workspacePath || "打开一个项目后才能添加 MCP 服务器"}</span></div>
              </div>

              {showReportedMcpStatus && (
                <div className="mcp-settings__runtime" role="status">
                  <strong>Grok 运行时报告 {reportedMcpServerCountLabel(runtime)} 个 MCP 服务器</strong>
                  <span>该数量可能包含本页配置和 Grok CLI 自身管理的服务器；为保护命令、参数、URL、Header 与环境变量，桌面端不会回传或显示详情。</span>
                </div>
              )}

              {hasUnrestoredMcp && (
                <div className="mcp-settings__retained" role="status">
                  <strong>当前连接仍在使用仅内存 MCP 配置</strong>
                  <span>界面重新载入后不会从主进程回传 URL、命令、参数、Header 或环境变量，因此详情无法恢复。重新连接前仍可使用；应用当前空配置后将清除。</span>
                </div>
              )}

              {mcpConfigError && <small className="mcp-settings__error" id="mcp-settings-error" role="alert">{mcpConfigError}</small>}
              {mcpPickerError && <small className="mcp-settings__error" role="alert">{mcpPickerError}</small>}

              {draftMcpServers.length === 0 ? (
                <div className="mcp-settings__empty">
                  <strong>{!workspacePath ? "先选择工作区" : capabilitiesAuthoritative && availableMcpTransports.length === 0 ? "当前 Grok 未提供可用 MCP 传输" : "尚未配置 MCP 服务器"}</strong>
                  <span>{!workspacePath ? "MCP 配置不会作为所有项目共享的默认值。" : capabilitiesAuthoritative && availableMcpTransports.length === 0 ? "更换 Grok 版本后重新连接，桌面端会再次检测能力。" : "服务器提供的工具和上下文将只供当前工作区的 Grok 任务使用。"}</span>
                </div>
              ) : (
                <div className="mcp-server-list">
                  {draftMcpServers.map((server, serverIndex) => {
                    const currentTransportSupported = !capabilitiesAuthoritative || runtime.capabilities.mcp[server.type];
                    const headerTargetReady = server.type !== "stdio" && getMcpServerCredentialScope(server.url) !== undefined;
                    const serverLabel = server.name.trim() || `服务器 ${serverIndex + 1}`;
                    return (
                      <section className="mcp-server-editor" key={server.editorId}>
                        <header>
                          <div><strong>{serverLabel}</strong><span>{server.type === "stdio" ? "本地程序" : "远程服务"} · 仅当前桌面进程</span></div>
                          <button aria-label={`移除 ${serverLabel}`} className="mcp-icon-button is-danger" disabled={connectionBusy} onClick={() => removeMcpServer(serverIndex)} title="移除服务器" type="button"><CloseIcon size={14}/></button>
                        </header>

                        <div className="mcp-server-fields">
                          <label className="mcp-field">
                            <span>名称</span>
                            <input
                              autoComplete="off"
                              disabled={connectionBusy}
                              maxLength={MAX_MCP_SERVER_NAME_LENGTH}
                              onChange={(event) => updateMcpServer(serverIndex, (current) => ({ ...current, name: event.target.value }))}
                              placeholder="服务器名称"
                              spellCheck={false}
                              type="text"
                              value={server.name}
                            />
                          </label>
                          <label className="mcp-field">
                            <span>传输</span>
                            <select
                              disabled={connectionBusy}
                              onChange={(event) => changeMcpServerTransport(serverIndex, event.target.value as McpTransport)}
                              value={server.type}
                            >
                              {!currentTransportSupported && <option value={server.type}>{server.type.toUpperCase()} · 当前不支持</option>}
                              {availableMcpTransports.map((transport) => <option disabled={transport === "stdio" && server.type !== "stdio" && stdioServerCount >= MAX_MCP_STDIO_SERVERS} key={transport} value={transport}>{transport.toUpperCase()}</option>)}
                            </select>
                          </label>
                        </div>

                        {server.type === "stdio" ? (
                          <>
                            <div className="mcp-stdio-trust" role="note">
                              <TerminalIcon size={16}/>
                              <div><strong>此服务器会运行本地程序</strong><span>创建或载入任务时，Grok 将直接启动所选可执行文件。桌面端会隔离此处未明确配置的环境变量，但程序仍拥有当前 Windows 用户权限；该隔离不管理 Grok CLI 自行配置的 MCP。</span></div>
                            </div>
                            <div className="mcp-stdio-command">
                              <label className="mcp-field">
                                <span>可执行文件</span>
                                <div className="mcp-command-row">
                                  <input
                                    autoCapitalize="none"
                                    autoComplete="off"
                                    disabled={connectionBusy}
                                    maxLength={MAX_MCP_STDIO_COMMAND_LENGTH}
                                    placeholder="选择本机 .exe 可执行文件"
                                    readOnly
                                    spellCheck={false}
                                    title={server.command || "使用右侧按钮选择本机可执行文件"}
                                    type="text"
                                    value={server.command}
                                  />
                                  <button className="subtle-button" disabled={connectionBusy} onClick={() => void chooseMcpExecutable(serverIndex)} type="button">选择…</button>
                                </div>
                              </label>
                            </div>

                            <div className="mcp-header-section mcp-stdio-section">
                              <div className="mcp-header-section__title">
                                <div><strong>参数</strong><span>{server.args.length ? `${server.args.length} 个` : "可选"}</span></div>
                                <button disabled={connectionBusy || server.args.length >= MAX_MCP_STDIO_ARGUMENTS_PER_SERVER} onClick={() => addMcpArgument(serverIndex)} type="button"><PlusIcon size={13}/>添加参数</button>
                              </div>
                              {server.args.length > 0 && <div className="mcp-argument-list">{server.args.map((argument, argumentIndex) => <div className="mcp-argument-row" key={argumentIndex}><span>{argumentIndex + 1}</span><input aria-label={`${serverLabel} 参数 ${argumentIndex + 1}`} autoComplete="off" disabled={connectionBusy} maxLength={MAX_MCP_STDIO_ARGUMENT_LENGTH} onChange={(event) => updateMcpArgument(serverIndex, argumentIndex, event.target.value)} placeholder="一个独立参数" spellCheck={false} type="text" value={argument}/><button aria-label={`移除 ${serverLabel} 的参数 ${argumentIndex + 1}`} disabled={connectionBusy} onClick={() => removeMcpArgument(serverIndex, argumentIndex)} title="移除参数" type="button"><CloseIcon size={13}/></button></div>)}</div>}
                              <small>每一行都会作为独立参数传给程序；桌面端不会解析引号、管道或 shell 语法。密钥请放在下方环境变量中。</small>
                            </div>

                            <div className="mcp-header-section mcp-stdio-section">
                              <div className="mcp-header-section__title">
                                <div><strong>环境变量</strong><span>{server.env.length ? `${server.env.length} 个` : "可选"}</span></div>
                                <div>
                                  <button aria-controls={`mcp-env-${server.editorId}`} aria-label={`${server.showEnvironmentValues ? "隐藏" : "显示"} ${serverLabel} 的环境变量值`} aria-pressed={server.showEnvironmentValues} disabled={connectionBusy || server.env.length === 0} onClick={() => updateMcpServer(serverIndex, (current) => current.type === "stdio" ? { ...current, showEnvironmentValues: !current.showEnvironmentValues } : current)} type="button">{server.showEnvironmentValues ? "隐藏值" : "显示值"}</button>
                                  <button disabled={connectionBusy || server.env.length >= MAX_MCP_STDIO_ENV_PER_SERVER} onClick={() => addMcpEnvironmentVariable(serverIndex)} type="button"><PlusIcon size={13}/>添加变量</button>
                                </div>
                              </div>
                              {server.env.length > 0 && <div className="mcp-header-list" id={`mcp-env-${server.editorId}`}><div aria-hidden="true" className="mcp-header-columns"><span>名称</span><span>值</span><span/></div>{server.env.map((variable, variableIndex) => <div className="mcp-header-row" key={variableIndex}><input aria-label={`${serverLabel} 环境变量 ${variableIndex + 1} 名称`} autoCapitalize="none" autoComplete="off" disabled={connectionBusy} maxLength={MAX_MCP_STDIO_ENV_NAME_LENGTH} onChange={(event) => updateMcpEnvironmentVariable(serverIndex, variableIndex, "name", event.target.value)} placeholder="MCP_TOKEN" spellCheck={false} type="text" value={variable.name}/><input aria-label={`${serverLabel} 环境变量 ${variableIndex + 1} 值`} autoCapitalize="none" autoComplete="new-password" disabled={connectionBusy} maxLength={MAX_MCP_STDIO_ENV_VALUE_LENGTH} onChange={(event) => updateMcpEnvironmentVariable(serverIndex, variableIndex, "value", event.target.value)} placeholder="仅保存在内存" spellCheck={false} type={server.showEnvironmentValues ? "text" : "password"} value={variable.value}/><button aria-label={`移除 ${serverLabel} 的环境变量 ${variableIndex + 1}`} disabled={connectionBusy} onClick={() => removeMcpEnvironmentVariable(serverIndex, variableIndex)} title="移除环境变量" type="button"><CloseIcon size={13}/></button></div>)}</div>}
                              <small>显式值只交给这个程序且不会写入设置；其余非运行必需的父进程环境变量会在 Main 中置空。</small>
                            </div>
                          </>
                        ) : (
                          <>
                            <div className="mcp-server-url">
                              <label className="mcp-field">
                                <span>服务器 URL</span>
                                <input autoCapitalize="none" autoComplete="off" disabled={connectionBusy} inputMode="url" maxLength={MAX_MCP_SERVER_URL_LENGTH} onChange={(event) => changeMcpServerUrl(serverIndex, event.target.value)} placeholder={server.type === "sse" ? "https://example.com/events" : "https://example.com/mcp"} spellCheck={false} type="text" value={server.url}/>
                              </label>
                            </div>
                            <div className="mcp-header-section">
                              <div className="mcp-header-section__title">
                                <div><strong>请求 Header</strong><span>{server.headers.length ? `${server.headers.length} 个` : "可选"}</span></div>
                                <div>
                                  <button aria-controls={`mcp-headers-${server.editorId}`} aria-label={`${server.showHeaderValues ? "隐藏" : "显示"} ${serverLabel} 的 Header 值`} aria-pressed={server.showHeaderValues} disabled={connectionBusy || !headerTargetReady || server.headers.length === 0} onClick={() => updateMcpServer(serverIndex, (current) => current.type === "stdio" ? current : { ...current, showHeaderValues: !current.showHeaderValues })} type="button">{server.showHeaderValues ? "隐藏值" : "显示值"}</button>
                                  <button disabled={connectionBusy || !headerTargetReady || server.headers.length >= MAX_MCP_HEADERS_PER_SERVER} onClick={() => addMcpHeader(serverIndex)} type="button"><PlusIcon size={13}/>添加 Header</button>
                                </div>
                              </div>
                              {server.headers.length > 0 && <div className="mcp-header-list" id={`mcp-headers-${server.editorId}`}><div aria-hidden="true" className="mcp-header-columns"><span>名称</span><span>值</span><span/></div>{server.headers.map((header, headerIndex) => <div className="mcp-header-row" key={headerIndex}><input aria-label={`服务器 ${serverIndex + 1} Header ${headerIndex + 1} 名称`} autoCapitalize="none" autoComplete="off" disabled={connectionBusy || !headerTargetReady} maxLength={MAX_MCP_HEADER_NAME_LENGTH} onChange={(event) => updateMcpHeader(serverIndex, headerIndex, "name", event.target.value)} placeholder="Authorization" spellCheck={false} type="text" value={header.name}/><input aria-label={`服务器 ${serverIndex + 1} Header ${headerIndex + 1} 值`} autoCapitalize="none" autoComplete="new-password" disabled={connectionBusy || !headerTargetReady} maxLength={MAX_MCP_HEADER_VALUE_LENGTH} onChange={(event) => updateMcpHeader(serverIndex, headerIndex, "value", event.target.value)} placeholder="仅保存在内存" spellCheck={false} type={server.showHeaderValues ? "text" : "password"} value={header.value}/><button aria-label={`移除 ${serverLabel} 的 Header ${headerIndex + 1}`} disabled={connectionBusy} onClick={() => removeMcpHeader(serverIndex, headerIndex)} title="移除 Header" type="button"><CloseIcon size={13}/></button></div>)}</div>}
                              <small>Header 会交给当前工作区的外部 Grok 进程并发送到此服务器，不会写入设置、快照或任务历史。</small>
                              {!headerTargetReady && <small className="mcp-header-section__notice" role="status">先输入有效的服务器 URL，再绑定 Header。</small>}
                              {server.headersClearedForEndpointChange && <small className="mcp-header-section__notice" role="status">旧 Header 已从设置草稿移除；应用并重新连接后将停止使用原配置。</small>}
                            </div>
                          </>
                        )}
                      </section>
                    );
                  })}
                </div>
              )}

              {hasStdioServer && (
                <label className={`mcp-stdio-consent${stdioExecutionConfirmed ? " is-confirmed" : ""}`}>
                  <input checked={stdioExecutionConfirmed} disabled={connectionBusy} onChange={(event) => setStdioExecutionConfirmed(event.target.checked)} type="checkbox"/>
                  <span><strong>允许 Grok 为这个工作区启动上述本地 MCP 程序</strong><small>我已核对可执行文件与参数，并确认这些程序可信。此确认只适用于本次设置操作。</small></span>
                </label>
              )}
              {stdioConfirmationMissing && <small className="mcp-settings__error" id="mcp-stdio-confirmation" role="alert">应用前需要确认本地程序执行边界。</small>}

              <div className="mcp-settings__footer">
                <button className="subtle-button" disabled={!workspacePath || connectionBusy || availableMcpTransports.length === 0 || draftMcpServers.length >= MAX_MCP_SERVERS} onClick={addMcpServer} type="button"><PlusIcon size={14}/>添加服务器</button>
                <span>{draftMcpServers.length}/{MAX_MCP_SERVERS}</span>
              </div>
          </section>

          <section className="settings-group" aria-labelledby="permission-settings-title">
            <div className="settings-group__heading"><h3 id="permission-settings-title">权限策略</h3><p>选择 Grok 原生权限模式。应用后会重新连接，正在运行任务时不能切换。</p></div>
            <div aria-label="权限策略" className="permission-mode-settings" role="radiogroup">
              {PERMISSION_MODE_OPTIONS.map((option) => (
                <button
                  aria-checked={draftPermissionMode === option.id}
                  className={`${option.danger ? "is-danger " : ""}${draftPermissionMode === option.id ? "is-selected" : ""}`.trim()}
                  disabled={connectionBusy || taskBusy}
                  key={option.id}
                  onClick={() => setDraftPermissionMode(option.id)}
                  role="radio"
                  type="button"
                >
                  <span className="permission-mode-settings__check">{draftPermissionMode === option.id && <CheckIcon size={14}/>}</span>
                  <span><strong>{option.label}{option.recommended && <em>推荐</em>}</strong><small>{option.description}</small></span>
                </button>
              ))}
            </div>
          </section>

          <section className="settings-group settings-meta" aria-labelledby="runtime-info-title">
            <div className="settings-group__heading"><h3 id="runtime-info-title">运行信息</h3></div>
            <dl><div><dt>桌面端</dt><dd>v{bootstrap.appVersion}</dd></div><div><dt>Grok</dt><dd>{runtime.grokVersion || installation?.version || "未知"}</dd></div><div><dt>ACP</dt><dd>{runtime.protocolVersion ?? "未连接"}</dd></div><div><dt>API</dt><dd title={runtime.xaiApiBaseUrl ?? undefined}>{runtime.phase === "offline" ? "未连接" : runtime.xaiApiBaseUrl || "未配置"}</dd></div><div><dt>权限</dt><dd>{runtime.permissionMode ? permissionModeLabel(runtime.permissionMode) : permissionModeLabel(draftPermissionMode)}</dd></div><div><dt>平台</dt><dd>{bootstrap.platform}</dd></div></dl>
          </section>
        </div>

        <footer>
          <button aria-label={disconnectControl.label} className="danger-button" disabled={disconnectControl.disabled || connectionBusy} onClick={onDisconnect} title={disconnectControl.title} type="button">{disconnectControl.label}</button>
          <div><button className="subtle-button" disabled={connectionBusy} onClick={requestClose} type="button">取消</button><button aria-busy={connectionBusy} aria-describedby={connectionPairError || modelDiscoveryPhase !== "ready" || modelSelectionInvalid ? "model-discovery-status" : apiKeyReentryRequired ? "xai-api-key-reentry-notice" : mcpConfigError ? "mcp-settings-error" : stdioConfirmationMissing ? "mcp-stdio-confirmation" : undefined} className="primary-button" disabled={Boolean(connectionPairError) || apiKeyReentryRequired || modelDiscoveryPhase !== "ready" || modelSelectionInvalid || Boolean(mcpConfigError) || stdioConfirmationMissing || connectionBusy || reconnectBlocked} onClick={() => void applySettings()} title={reconnectBlocked ? "请先停止当前任务，再重新连接" : connectionPairError ?? (modelDiscoveryPhase !== "ready" ? "请先检测地址并获取模型" : modelSelectionInvalid ? "请至少启用并选择一个模型" : apiKeyReentryRequired ? "请重新输入当前连接使用的 API Key" : mcpConfigError ?? (stdioConfirmationMissing ? "请先确认本地程序执行边界" : undefined))} type="button">{connectionBusy ? "正在应用…" : reconnectBlocked ? "任务运行中" : hasWorkspace ? "应用并重新连接" : "应用"}</button></div>
        </footer>
      </section>
    </div>
  );
}

function PermissionModal({ permission, busy, frozen, queueLength, taskTitle, workspacePath, isCurrentTask, onResolve }: {
  permission: PermissionRequestPayload;
  busy: boolean;
  frozen: boolean;
  queueLength: number;
  taskTitle: string;
  workspacePath: string | null;
  isCurrentTask: boolean;
  onResolve(optionId: string | null): void;
}) {
  const dialogRef = useDialogFocus<HTMLElement>(permission.requestId);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [permission.requestId]);
  const toolTitle = typeof permission.toolCall.title === "string" ? permission.toolCall.title : permission.title;
  const kind = typeof permission.toolCall.kind === "string" ? permission.toolCall.kind : "工具操作";
  const locations = permissionLocations(permission.toolCall);
  const rawInput = permission.toolCall.rawInput;
  const command = findPermissionDetail(rawInput, ["command", "commandline", "cmd", "script"]);
  const workingDirectory = findPermissionDetail(rawInput, ["cwd", "workingdirectory", "workdir"]);
  const target = findPermissionDetail(rawInput, ["url", "uri", "target", "destination", "path"]);
  const hasImpactDetails = Boolean(command || workingDirectory || target || locations.length);
  const immediateOptions = permission.options.filter((option) => option.kind === "allow_once" || option.kind === "reject_once");
  const persistentOptions = permission.options.filter((option) => option.kind === "allow_always" || option.kind === "reject_always");
  const remainingMs = Date.parse(permission.expiresAt) - now;
  const remainingLabel = Number.isFinite(remainingMs) ? remainingMs <= 0 ? "即将自动取消" : `将在 ${Math.max(1, Math.ceil(remainingMs / 1000))} 秒后自动取消` : null;
  const renderOption = (option: PermissionRequestPayload["options"][number]) => {
    const tone = permissionOptionTone(option.kind);
    return <button className={`${tone}-button permission-option permission-option--${option.kind}`} disabled={busy || frozen} key={option.optionId} onClick={() => onResolve(option.optionId)} type="button"><span><strong>{option.name}</strong><small>{permissionOptionKindLabel(option.kind)}</small></span></button>;
  };
  return (
    <div className="modal-layer modal-layer--permission" role="presentation">
      <section aria-busy={busy} aria-describedby="permission-summary permission-expiry" aria-labelledby="permission-title" aria-modal="true" className="modal permission-modal" ref={dialogRef} role="alertdialog" tabIndex={-1}>
        <header><div className="permission-icon"><AlertIcon size={21}/></div><div><p className="eyebrow">需要你的授权{queueLength > 1 ? ` · 队列中还有 ${queueLength - 1} 项` : ""}</p><h2 id="permission-title">{permission.title || "Grok 请求执行操作"}</h2></div></header>
        {!isCurrentTask && <div className="permission-source-warning"><AlertIcon size={15}/><span>这项请求来自另一个任务，请先核对来源和影响范围。</span></div>}
        <div className="permission-source"><span><ChatIcon size={16}/></span><div><small>请求来源</small><strong>{taskTitle}</strong><code title={workspacePath ?? undefined}>{workspacePath || "当前 Grok 工作区"}</code></div><em>{permission.sessionId.slice(0, 8)}</em></div>
        <div className="permission-tool"><span>{["read", "edit", "delete", "move", "search"].includes(kind) ? <FileIcon size={16}/> : <TerminalIcon size={16}/>}</span><div><strong>{toolTitle}</strong><small>{permissionToolKindLabel(kind)}{locations.length ? ` · ${locations.length} 个位置` : ""}</small></div></div>
        <div className="permission-impact" id="permission-summary">
          {command && <div><span>命令</span><code>{command}</code></div>}
          {workingDirectory && <div><span>工作目录</span><code>{workingDirectory}</code></div>}
          {target && target !== workingDirectory && <div><span>目标</span><code>{target}</code></div>}
          {locations.length > 0 && <div className="permission-impact__locations"><span>涉及位置</span><div>{locations.map((location) => <code key={location}>{location}</code>)}</div></div>}
          {!hasImpactDetails && <p>Grok 未提供可审阅的命令、路径或目标详情。未知影响默认不应长期批准。</p>}
        </div>
        <div className="permission-expiry" id="permission-expiry">{remainingLabel ?? "授权请求有时效限制"}</div>
        {frozen && <div className="permission-frozen" role="status"><StopIcon size={14}/><span>任务正在停止，这项授权已冻结。</span></div>}
        <details className="permission-details"><summary>更多详情（敏感字段已隐藏） <ChevronIcon size={14}/></summary><pre>{summarizePermissionDetails(permission.toolCall)}</pre></details>
        <div className="permission-options">
          {immediateOptions.map(renderOption)}
          {persistentOptions.length > 0 && <section className="permission-persistent"><div><AlertIcon size={15}/><span>以下决定会持续影响后续同类请求，请确认作用范围。</span></div>{persistentOptions.map(renderOption)}</section>}
        </div>
        {busy && <div className="permission-submitting" role="status">正在提交你的决定…</div>}
        <button className="permission-cancel" disabled={busy || frozen} onClick={() => onResolve(null)} type="button">取消此次操作</button>
      </section>
    </div>
  );
}

export function permissionOptionTone(kind: PermissionOptionKind): "primary" | "danger" | "subtle" {
  if (kind === "allow_once") return "primary";
  if (kind === "allow_always") return "danger";
  return "subtle";
}

export function permissionOptionKindLabel(kind: PermissionOptionKind): string {
  switch (kind) {
    case "allow_once": return "仅批准这一次";
    case "allow_always": return "对后续同类操作持续批准";
    case "reject_once": return "仅拒绝这一次";
    case "reject_always": return "对后续同类操作持续拒绝";
  }
}

export function permissionToolKindLabel(kind: string): string {
  return toolKindLabel(kind);
}

const FILE_TOOL_KINDS = new Set(["read", "edit", "delete", "move", "search"]);

export function isFileToolKind(kind: string): boolean {
  return FILE_TOOL_KINDS.has(kind.trim().toLocaleLowerCase("en-US"));
}

export function toolKindLabel(kind: string): string {
  const normalizedKind = kind.trim().toLocaleLowerCase("en-US");
  const labels: Record<string, string> = {
    read: "读取文件",
    edit: "修改文件",
    delete: "删除内容",
    move: "移动内容",
    search: "搜索项目",
    execute: "执行命令",
    think: "内部分析",
    fetch: "访问网络",
    switch_mode: "切换模式",
    other: "工具操作",
  };
  return labels[normalizedKind] ?? (kind.trim() || "工具操作");
}

function permissionLocations(toolCall: Record<string, unknown>): string[] {
  if (!Array.isArray(toolCall.locations)) return [];
  return toolCall.locations.slice(0, 8).flatMap((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
    const record = value as Record<string, unknown>;
    if (typeof record.path !== "string" || !record.path.trim()) return [];
    const line = typeof record.line === "number" && Number.isSafeInteger(record.line) && record.line > 0 ? `:${record.line}` : "";
    return [`${redactPermissionText(record.path.trim())}${line}`];
  });
}

function findPermissionDetail(value: unknown, keys: readonly string[], depth = 0): string | null {
  if (depth > 3 || typeof value !== "object" || value === null) return null;
  const normalizedKeys = new Set(keys.map((key) => key.replace(/[^a-z0-9]/giu, "").toLocaleLowerCase("en-US")));
  if (Array.isArray(value)) {
    for (const entry of value.slice(0, 32)) {
      const nested = findPermissionDetail(entry, keys, depth + 1);
      if (nested) return nested;
    }
    return null;
  }
  const entries = Object.entries(value as Record<string, unknown>).slice(0, 64);
  for (const [entryKey, entryValue] of entries) {
    const normalizedKey = entryKey.replace(/[^a-z0-9]/giu, "").toLocaleLowerCase("en-US");
    if (!normalizedKeys.has(normalizedKey)) continue;
    const display = permissionDetailValue(entryValue);
    if (display) return display;
  }
  for (const [entryKey, entryValue] of entries) {
    if (entryKey === "_meta" || entryKey === "rawOutput") continue;
    const nested = findPermissionDetail(entryValue, keys, depth + 1);
    if (nested) return nested;
  }
  return null;
}

function permissionDetailValue(value: unknown): string | null {
  if (typeof value === "string") return value.trim() ? redactPermissionText(value.trim()) : null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "string" || typeof entry === "number")) {
    return redactPermissionText(value.slice(0, 32).join(" "));
  }
  return null;
}

function ToastStack({ notices, onDismiss }: { notices: NoticeState[]; onDismiss(id: number): void }) {
  return <div className="toast-stack" aria-live="polite">{notices.map((notice) => <div className="toast" data-level={notice.level} key={notice.id}>{notice.level === "error" || notice.level === "warning" ? <AlertIcon size={17}/> : <CheckIcon size={17}/>}<span>{notice.message}</span><button aria-label="关闭通知" onClick={() => onDismiss(notice.id)} type="button"><CloseIcon size={14}/></button></div>)}</div>;
}

export default App;
