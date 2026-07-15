import { describe, expect, it } from "vitest";
import {
  permissionOptionKindLabel,
  permissionOptionTone,
  permissionToolKindLabel,
  isFileToolKind,
  toolKindLabel,
  getActiveModelLabel,
  getAuthMethodPresentations,
  getConversationAlerts,
  getXaiConnectionBadge,
  getXaiApiCredentialScope,
  getUsageDetailRows,
  getUsageLabel,
  deriveLocalSessionTitle,
  canRemoveStoredSession,
  filterStoredSessions,
  groupStoredSessionsByRecency,
  hasUnrestoredMcpConfiguration,
  isTimelineNearBottom,
  mcpSettingsError,
  mergeContextFiles,
  redactSensitiveText,
  reportedMcpServerCountLabel,
  requiresXaiApiKeyReentry,
  sessionLoadFailureDetail,
  resolveRequestedPermissionMode,
  reasoningEffortsForModel,
  resolvePermissionSource,
  resolveWorkspaceContext,
  preferredReasoningEffort,
  runtimeCapabilitiesApplyToExecutable,
  runtimeMcpStatusAppliesToWorkspace,
  sessionSearchEscapeAction,
  settingsDisconnectControl,
  shouldGroupStoredSessions,
  shouldOfferSessionSearch,
  moveCommandSelection,
  shouldAutoConnectWorkspace,
  transitionXaiApiKeyForBaseUrl,
  turnOutcomePresentation,
  validateXaiApiBaseUrl,
  xaiApiKeyHelpText,
} from "./App";
import {
  createEmptyRuntimeCapabilities,
  isPermissionOptionKind,
} from "../shared/contracts";
import type { RuntimeSnapshot, StoredSession } from "../shared/contracts";
import { createEmptySessionView } from "./lib/acp";

describe("xAI connection settings", () => {
  it("accepts empty, secure remote, and explicit local development URLs", () => {
    expect(validateXaiApiBaseUrl("")).toBeNull();
    expect(validateXaiApiBaseUrl("https://api.x.ai/v1")).toBeNull();
    expect(validateXaiApiBaseUrl("http://localhost:8080/v1")).toBeNull();
    expect(validateXaiApiBaseUrl("http://localhost.:8080/v1")).toBeNull();
    expect(validateXaiApiBaseUrl("http://127.0.0.1:8080/v1")).toBeNull();
    expect(validateXaiApiBaseUrl("http://127.42.0.1:8080/v1")).toBeNull();
    expect(validateXaiApiBaseUrl("http://[::1]:8080/v1")).toBeNull();
  });

  it("rejects insecure remote URLs and unsupported schemes", () => {
    expect(validateXaiApiBaseUrl("http://api.x.ai/v1")).toContain("必须使用 HTTPS");
    expect(validateXaiApiBaseUrl("ftp://api.x.ai/v1")).toContain("仅支持 HTTPS");
    expect(validateXaiApiBaseUrl("api.x.ai/v1")).toContain("请输入完整 URL");
  });

  it("rejects credentials, query strings, and fragments", () => {
    expect(validateXaiApiBaseUrl("https://user:secret@api.x.ai/v1")).toContain("用户名或密码");
    expect(validateXaiApiBaseUrl("https://api.x.ai/v1?region=us")).toContain("查询参数或片段");
    expect(validateXaiApiBaseUrl("https://api.x.ai/v1#models")).toContain("查询参数或片段");
    expect(validateXaiApiBaseUrl("https://api.x.ai/v1?")).toContain("查询参数或片段");
  });

  it("rejects URLs beyond the shared IPC length limit", () => {
    expect(validateXaiApiBaseUrl(`https://api.x.ai/${"a".repeat(2_048)}`)).toContain("不能超过");
  });

  it("redacts exact and URL-encoded API keys before text reaches the UI", () => {
    const key = "sk-test secret";
    expect(redactSensitiveText(`Connection failed for ${key}`, key)).toBe("Connection failed for [已隐藏]");
    expect(redactSensitiveText(`Connection failed for ${encodeURIComponent(key)}`, key)).toBe("Connection failed for [已隐藏]");
  });

  it("explains the credential source difference between default and custom endpoints", () => {
    expect(xaiApiKeyHelpText(" ")).toContain("原生登录或继承凭据");
    expect(xaiApiKeyHelpText("https://gateway.example.com/v1")).toContain("不会继承");
    expect(xaiApiKeyHelpText("https://gateway.example.com/v1")).toContain("明确输入");
  });

  it("presents only the authentication methods advertised for Grok's default endpoint", () => {
    const methods = [
      { id: "xai.api_key", name: "xai.api_key", description: "env" },
      { id: "grok.com", name: "Grok", description: "Sign in with Grok" },
      { id: "future.auth", name: "Future auth", description: "Agent managed" },
    ];
    expect(getAuthMethodPresentations(methods, "https://gateway.example.com/v1")).toEqual([]);
    expect(getAuthMethodPresentations(methods, "")).toEqual([
      {
        id: "xai.api_key",
        label: "API Key",
        detail: "可由 Grok 的环境变量或 config.toml 提供",
        managedLogin: false,
      },
      {
        id: "grok.com",
        label: "Grok 登录",
        detail: "由 Grok 原始终端完成；桌面端不接管登录凭据",
        managedLogin: true,
      },
      {
        id: "future.auth",
        label: "Future auth",
        detail: "Agent managed",
        managedLogin: false,
      },
    ]);
  });

  it("scopes an in-memory API key to the endpoint origin", () => {
    expect(getXaiApiCredentialScope("")).toBeNull();
    expect(getXaiApiCredentialScope("https://API.X.AI:443/v1")).toBe("https://api.x.ai");
    expect(getXaiApiCredentialScope("http://localhost:8080/v1")).toBe("http://localhost:8080");
    expect(getXaiApiCredentialScope("not a url")).toBeUndefined();
  });

  it("clears an existing key before changing credential authority", () => {
    const sameOrigin = transitionXaiApiKeyForBaseUrl(
      "sk-memory-only",
      "https://api.x.ai",
      "https://api.x.ai/v2",
    );
    expect(sameOrigin).toMatchObject({ apiKey: "sk-memory-only", cleared: false });

    const newOrigin = transitionXaiApiKeyForBaseUrl(
      "sk-memory-only",
      "https://api.x.ai",
      "https://gateway.example.com/v1",
    );
    expect(newOrigin).toEqual({
      apiKey: "",
      apiKeyScope: "https://gateway.example.com",
      cleared: true,
    });
  });

  it("keeps the last valid key scope while the URL is incomplete", () => {
    expect(transitionXaiApiKeyForBaseUrl(
      "sk-memory-only",
      "https://api.x.ai",
      "https://",
    )).toEqual({
      apiKey: "sk-memory-only",
      apiKeyScope: "https://api.x.ai",
      cleared: false,
    });
  });

  it("clears an unbound key when the URL first becomes a valid origin", () => {
    expect(transitionXaiApiKeyForBaseUrl(
      "sk-unbound",
      undefined,
      "https://api.x.ai/v1",
    )).toEqual({
      apiKey: "",
      apiKeyScope: "https://api.x.ai",
      cleared: true,
    });
  });

  it("requires re-entry before a renderer reload can drop an active in-memory key", () => {
    const runtime = {
      xaiApiBaseUrl: "https://gateway.example.com/v1",
      xaiApiKeyConfigured: true,
    };
    expect(requiresXaiApiKeyReentry(runtime, "https://gateway.example.com/v2", "")).toBe(true);
    expect(requiresXaiApiKeyReentry(runtime, "https://gateway.example.com/v2", "replacement-key")).toBe(false);
    expect(requiresXaiApiKeyReentry(runtime, "https://other.example.com/v1", "")).toBe(false);
    expect(requiresXaiApiKeyReentry({ ...runtime, xaiApiKeyConfigured: false }, "https://gateway.example.com/v1", "")).toBe(false);
    expect(requiresXaiApiKeyReentry({ ...runtime, xaiApiBaseUrl: null }, "", "")).toBe(true);
  });

  it("derives a non-verbatim local title until Grok supplies one", () => {
    const prompt = "Fix the login callback and add a focused regression test";
    const title = deriveLocalSessionTitle(prompt);

    expect(title).toBe("修复问题");
    expect(title).not.toBe(prompt);
    expect(title).not.toContain("login");
    expect(deriveLocalSessionTitle("全面扫描当前目录")).toBe("分析项目");
    expect(deriveLocalSessionTitle("ok")).toBe("Grok 任务");
    expect(deriveLocalSessionTitle("", ["package.json"])).toBe("处理文件 · package.json");
    expect(deriveLocalSessionTitle(prompt, ["auth.ts"])).toBe("修复问题 · auth.ts");
  });

  it("shows only non-secret custom API context beside the composer", () => {
    expect(getXaiConnectionBadge({
      xaiApiBaseUrl: null,
      xaiApiKeyConfigured: false,
    })).toBeNull();
    expect(getXaiConnectionBadge({
      xaiApiBaseUrl: "https://gateway.example.com/v1",
      xaiApiKeyConfigured: true,
    })).toEqual({
      label: "gateway.example.com · 内存 Key",
      title: "当前 API：https://gateway.example.com/v1；API Key 仅保存在当前桌面进程。点击打开连接设置。",
      keyConfigured: true,
    });
    expect(getXaiConnectionBadge({
      xaiApiBaseUrl: null,
      xaiApiKeyConfigured: true,
    })?.label).toBe("Grok 默认 · 内存 Key");
  });
});

describe("MCP connection settings", () => {
  const server = [{
    type: "sse" as const,
    name: "Project events",
    url: "https://mcp.example.com/events",
    headers: [],
  }];
  const runtime: RuntimeSnapshot = {
    phase: "ready",
    permissionMode: "default",
    xaiApiBaseUrl: null,
    xaiApiKeyConfigured: false,
    mcpConfigured: false,
    reportedMcpServerCount: 0,
    reportedMcpServerCountTruncated: false,
    workspacePath: "D:\\project",
    executablePath: "D:\\grok.exe",
    grokVersion: "0.2.101",
    protocolVersion: 1,
    currentModelId: null,
    availableModels: [],
    authMethods: [],
    capabilities: {
      ...createEmptyRuntimeCapabilities(),
      mcp: { stdio: false, http: true, sse: false, acp: false },
    },
    sessionExecutions: [],
    message: null,
  };

  it("allows structurally valid settings until Grok capabilities are authoritative", () => {
    expect(mcpSettingsError(server, { ...runtime, protocolVersion: null })).toBeNull();
    expect(mcpSettingsError(server, runtime, false)).toBeNull();
  });

  it("rejects a transport the selected Grok executable did not advertise", () => {
    expect(mcpSettingsError(server, runtime, true)).toContain("未广告 MCP SSE");
    expect(runtimeCapabilitiesApplyToExecutable(runtime, "D:\\grok.exe")).toBe(true);
    expect(runtimeCapabilitiesApplyToExecutable(runtime, "D:\\other-grok.exe")).toBe(false);
  });

  it("gates local stdio MCP on the connected Grok capability", () => {
    const stdio = [{
      type: "stdio" as const,
      name: "Local tools",
      command: "D:\\Tools\\mcp.exe",
      args: ["--workspace", "D:\\project"],
      env: [],
    }];
    expect(mcpSettingsError(stdio, runtime, true)).toContain("未广告 MCP STDIO");
    expect(mcpSettingsError(stdio, {
      ...runtime,
      capabilities: {
        ...runtime.capabilities,
        mcp: { ...runtime.capabilities.mcp, stdio: true },
      },
    }, true)).toBeNull();
  });

  it("detects an active Main-process MCP configuration that the reloaded UI cannot restore", () => {
    const retainedRuntime = { ...runtime, mcpConfigured: true };

    expect(hasUnrestoredMcpConfiguration(
      retainedRuntime,
      [],
      "d:/PROJECT",
      "win32",
    )).toBe(true);
    expect(hasUnrestoredMcpConfiguration(
      retainedRuntime,
      server,
      "D:\\project",
      "win32",
    )).toBe(false);
    expect(hasUnrestoredMcpConfiguration(
      retainedRuntime,
      [],
      "D:\\other-project",
      "win32",
    )).toBe(false);
  });

  it("shows Grok-reported MCP status only for the runtime workspace", () => {
    expect(runtimeMcpStatusAppliesToWorkspace(
      { ...runtime, reportedMcpServerCount: 2 },
      "d:/PROJECT",
      "win32",
    )).toBe(true);
    expect(runtimeMcpStatusAppliesToWorkspace(
      { ...runtime, reportedMcpServerCount: 2 },
      "D:\\other-project",
      "win32",
    )).toBe(false);
  });

  it("presents a bounded MCP count as a lower bound", () => {
    expect(reportedMcpServerCountLabel({
      ...runtime,
      reportedMcpServerCount: 256,
      reportedMcpServerCountTruncated: true,
    })).toBe("至少 256");
    expect(reportedMcpServerCountLabel({
      ...runtime,
      reportedMcpServerCount: 2,
    })).toBe("2");
  });
});

describe("workspace context", () => {
  it("keeps the selected project when the ACP runtime disconnects", () => {
    expect(resolveWorkspaceContext(null, "D:\\project", "D:\\older")).toBe("D:\\project");
  });

  it("prefers an active runtime workspace and falls back to the remembered project", () => {
    expect(resolveWorkspaceContext("D:\\active", "D:\\selected", "D:\\older")).toBe("D:\\active");
    expect(resolveWorkspaceContext(null, null, "D:\\remembered")).toBe("D:\\remembered");
  });
});

describe("model reasoning effort settings", () => {
  const models = [{
    id: "grok-build",
    name: "Grok Build",
    reasoningEffort: "high",
    reasoningEfforts: [
      { id: "low", name: "Low", isDefault: false },
      { id: "high", name: "High", isDefault: true },
    ],
  }];

  it("uses only the selected model's advertised reasoning-effort options", () => {
    expect(reasoningEffortsForModel(models, "grok-build")).toEqual(models[0]?.reasoningEfforts);
    expect(reasoningEffortsForModel(models, null)).toEqual([]);
    expect(reasoningEffortsForModel(models, "unknown")).toEqual([]);
    expect(preferredReasoningEffort(models, "grok-build")).toBe("high");
  });
});

describe("connection restore", () => {
  it("auto-connects only default and loopback endpoints without a persisted key", () => {
    expect(shouldAutoConnectWorkspace("")).toBe(true);
    expect(shouldAutoConnectWorkspace("http://localhost:8080/v1")).toBe(true);
    expect(shouldAutoConnectWorkspace("https://127.0.0.1:8443/v1")).toBe(true);
    expect(shouldAutoConnectWorkspace("https://gateway.example.com/v1")).toBe(false);
  });
});

describe("connection settings transaction", () => {
  it("uses an explicit permission draft only when settings are applied", () => {
    expect(resolveRequestedPermissionMode("default", { permissionMode: "auto" })).toBe("auto");
    expect(resolveRequestedPermissionMode("auto", { permissionMode: "always_approve" })).toBe("always_approve");
    expect(resolveRequestedPermissionMode("always_approve")).toBe("always_approve");
    expect(resolveRequestedPermissionMode("default", undefined, "auto")).toBe("auto");
  });
});

describe("slash command selection", () => {
  it("wraps keyboard selection through the available commands", () => {
    expect(moveCommandSelection(0, 1, 3)).toBe(1);
    expect(moveCommandSelection(2, 1, 3)).toBe(0);
    expect(moveCommandSelection(0, -1, 3)).toBe(2);
    expect(moveCommandSelection(0, 1, 0)).toBe(0);
  });
});

describe("local task search", () => {
  const sessions: StoredSession[] = [
    {
      sessionId: "session-api",
      title: "修复 API Key 重载保护",
      workspacePath: "D:\\project",
      createdAt: "2026-07-14T00:00:00.000Z",
      updatedAt: "2026-07-14T00:03:00.000Z",
    },
    {
      sessionId: "session-ui",
      title: "对齐 Codex 对话区样式",
      workspacePath: "D:\\project",
      createdAt: "2026-07-14T00:00:00.000Z",
      updatedAt: "2026-07-14T00:02:00.000Z",
    },
  ];

  it("filters local stored titles with case-insensitive, whitespace-separated terms", () => {
    expect(filterStoredSessions(sessions, " api   KEY ")).toEqual([sessions[0]]);
    expect(filterStoredSessions(sessions, "codex 样式")).toEqual([sessions[1]]);
    expect(filterStoredSessions(sessions, "session-api")).toEqual([]);
    expect(filterStoredSessions(sessions, "  ")).toEqual(sessions);
  });

  it("keeps search low-noise until the task list becomes difficult to scan", () => {
    expect(shouldOfferSessionSearch(7, false)).toBe(false);
    expect(shouldOfferSessionSearch(8, false)).toBe(true);
    expect(shouldOfferSessionSearch(2, true)).toBe(true);
    expect(shouldGroupStoredSessions(7)).toBe(false);
    expect(shouldGroupStoredSessions(8)).toBe(true);
  });

  it("clears the query before closing the search field on Escape", () => {
    expect(sessionSearchEscapeAction("api")).toBe("clear");
    expect(sessionSearchEscapeAction("")).toBe("close");
  });
});

describe("local task date grouping", () => {
  const now = new Date(2026, 6, 15, 12, 0, 0);
  const sessionAt = (sessionId: string, daysAgo: number): StoredSession => {
    const updatedAt = new Date(2026, 6, 15 - daysAgo, 10, 0, 0).toISOString();
    return {
      sessionId,
      title: sessionId,
      workspacePath: "D:\\project",
      createdAt: updatedAt,
      updatedAt,
    };
  };

  it("uses local calendar boundaries for Codex-style recency groups", () => {
    const groups = groupStoredSessionsByRecency([
      sessionAt("today", 0),
      sessionAt("yesterday", 1),
      sessionAt("seven-days", 7),
      sessionAt("eight-days", 8),
      sessionAt("thirty-days", 30),
      sessionAt("earlier", 31),
    ], now);

    expect(groups.map((group) => ({
      id: group.id,
      sessions: group.sessions.map((session) => session.sessionId),
    }))).toEqual([
      { id: "today", sessions: ["today"] },
      { id: "yesterday", sessions: ["yesterday"] },
      { id: "previous-7", sessions: ["seven-days"] },
      { id: "previous-30", sessions: ["eight-days", "thirty-days"] },
      { id: "earlier", sessions: ["earlier"] },
    ]);
  });

  it("keeps invalid legacy timestamps visible in the earlier group", () => {
    const invalid = { ...sessionAt("legacy", 0), updatedAt: "invalid" };
    expect(groupStoredSessionsByRecency([invalid], now)).toMatchObject([
      { id: "earlier", sessions: [invalid] },
    ]);
  });
});

describe("local recent task removal", () => {
  const execution = {
    sessionId: "session-1",
    phase: "working" as const,
    turnId: "turn-1",
    startedAt: "2026-07-15T00:00:00.000Z",
    finishedAt: null,
    stopReason: null,
    error: null,
    pendingPermissionCount: 0,
  };

  it("allows only untouched, inactive history to be removed locally", () => {
    expect(canRemoveStoredSession("session-1", null, [], undefined)).toBe(true);
    expect(canRemoveStoredSession("session-1", "session-1", [], undefined)).toBe(false);
    expect(canRemoveStoredSession("session-1", null, ["session-1"], undefined)).toBe(false);
    expect(canRemoveStoredSession("session-1", null, [], execution)).toBe(false);
    expect(canRemoveStoredSession("session-1", null, [], { ...execution, phase: "end_turn" })).toBe(true);
  });

  it("keeps failed history recovery details safe and compact", () => {
    const secret = "sk-history secret";
    expect(sessionLoadFailureDetail(new Error(`load failed for ${secret}\nretry later`), secret)).toBe(
      "load failed for [已隐藏] retry later",
    );
    expect(sessionLoadFailureDetail(" ", secret)).toBe("Grok 没有返回可用的历史任务。");
    expect(sessionLoadFailureDetail(new Error("x".repeat(240)), secret)).toHaveLength(180);
    expect(sessionLoadFailureDetail(new Error("x".repeat(240)), secret).endsWith("…")).toBe(true);
  });

  it("removes Electron IPC plumbing from Grok session load failures", () => {
    expect(sessionLoadFailureDetail(
      new Error("Error invoking remote method 'grok-desktop:load-session': Error: Unable to load the Grok session: Path not found."),
      "",
    )).toBe("Grok 找不到这条历史任务。它可能已不在当前 Grok 会话目录中。");
    expect(sessionLoadFailureDetail(
      new Error("Error invoking remote method 'grok-desktop:load-session': Error: Unable to load the Grok session: Permission denied"),
      "",
    )).toBe("Grok 无法加载此任务：Permission denied");
  });
});

describe("permission presentation", () => {
  it("uses ACP option kinds instead of guessing permission risk from labels", () => {
    expect(permissionOptionTone("allow_once")).toBe("primary");
    expect(permissionOptionTone("allow_always")).toBe("danger");
    expect(permissionOptionTone("reject_once")).toBe("subtle");
    expect(permissionOptionTone("reject_always")).toBe("subtle");
    expect(permissionOptionKindLabel("allow_always")).toContain("持续批准");
    expect(permissionToolKindLabel("delete")).toBe("删除内容");
    expect(toolKindLabel("read")).toBe("读取文件");
    expect(toolKindLabel("x.ai/custom_tool")).toBe("x.ai/custom_tool");
    expect(isFileToolKind(" SEARCH ")).toBe(true);
    expect(isFileToolKind("execute")).toBe(false);
    expect(isPermissionOptionKind("allow_once")).toBe(true);
    expect(isPermissionOptionKind("approve_everything")).toBe(false);
  });

  it("identifies permission requests from a task other than the active task", () => {
    const source = resolvePermissionSource(
      "session-a",
      { sessionId: "session-b", title: "当前任务", workspacePath: "D:\\project" },
      [{
        sessionId: "session-a",
        title: "后台构建任务",
        workspacePath: "D:\\project",
        createdAt: "2026-07-14T00:00:00.000Z",
        updatedAt: "2026-07-14T00:01:00.000Z",
      }],
      "D:\\fallback",
    );

    expect(source).toEqual({
      taskTitle: "后台构建任务",
      workspacePath: "D:\\project",
      isCurrentTask: false,
    });
  });
});

describe("turn outcome presentation", () => {
  it("does not present constrained or refused stops as successful completion", () => {
    expect(turnOutcomePresentation("end_turn")).toMatchObject({ label: "任务已完成", tone: "success" });
    expect(turnOutcomePresentation("max_tokens")).toMatchObject({ tone: "warning" });
    expect(turnOutcomePresentation("max_turn_requests")).toMatchObject({ tone: "warning" });
    expect(turnOutcomePresentation("refusal")).toMatchObject({ tone: "error" });
    expect(turnOutcomePresentation("max_tokens").detail).toContain("可能不完整");
  });
});

describe("runtime disconnect safety", () => {
  const runtime: Omit<RuntimeSnapshot, "sessionExecutions"> = {
    phase: "working",
    permissionMode: "default",
    xaiApiBaseUrl: null,
    xaiApiKeyConfigured: false,
    mcpConfigured: false,
    reportedMcpServerCount: 0,
    reportedMcpServerCountTruncated: false,
    workspacePath: "D:\\project",
    executablePath: "D:\\grok.exe",
    grokVersion: "test",
    protocolVersion: 1,
    currentModelId: null,
    availableModels: [],
    authMethods: [],
    capabilities: createEmptyRuntimeCapabilities(),
    message: null,
  };

  it("blocks ordinary disconnects while Grok is still working or awaiting permission", () => {
    for (const phase of ["working", "waiting_permission"] as const) {
      expect(settingsDisconnectControl({
        ...runtime,
        sessionExecutions: [{
          sessionId: "session-1",
          phase,
          turnId: "turn-1",
          startedAt: "2026-07-14T00:00:00.000Z",
          finishedAt: null,
          stopReason: null,
          error: null,
          pendingPermissionCount: phase === "waiting_permission" ? 1 : 0,
        }],
      }, true)).toMatchObject({ disabled: true, force: false, label: "断开当前连接" });
    }
  });

  it("exposes an explicit force-stop exit only after cancellation has started", () => {
    expect(settingsDisconnectControl({
      ...runtime,
      sessionExecutions: [{
        sessionId: "session-1",
        phase: "cancelling",
        turnId: "turn-1",
        startedAt: "2026-07-14T00:00:00.000Z",
        finishedAt: null,
        stopReason: null,
        error: null,
        pendingPermissionCount: 0,
      }],
    }, true)).toMatchObject({ disabled: false, force: true, label: "强制停止 Grok" });
  });
});

describe("context usage presentation", () => {
  it("shows the ACP used/size ratio and falls back to prompt token totals", () => {
    const view = createEmptySessionView();
    view.usage = {
      contextUsed: 12_500,
      contextSize: 100_000,
      totalTokens: 13_200,
      inputTokens: 12_000,
      outputTokens: 1_000,
      thoughtTokens: 200,
      cost: null,
    };
    expect(getUsageLabel(view)).toBe("13% 上下文");

    view.usage.contextUsed = null;
    view.usage.contextSize = null;
    expect(getUsageLabel(view)).toBe("13,200 tokens");
  });

  it("shows only Grok-provided usage fields without rounding small costs to zero", () => {
    const view = createEmptySessionView();
    view.usage = {
      contextUsed: 12_500,
      contextSize: 100_000,
      totalTokens: 13_200,
      inputTokens: 12_000,
      outputTokens: 1_000,
      thoughtTokens: null,
      cost: { amount: 0.00012, currency: "USD" },
    };

    expect(getUsageDetailRows(view)).toEqual([
      { id: "context", label: "上下文", value: "12,500 / 100,000 tokens" },
      { id: "input", label: "输入", value: "12,000 tokens" },
      { id: "output", label: "输出", value: "1,000 tokens" },
      { id: "total", label: "总计", value: "13,200 tokens" },
      { id: "cost", label: "累计费用", value: "0.00012 USD" },
    ]);
  });

  it("keeps a disclosure entry when Grok only reports partial usage", () => {
    const view = createEmptySessionView();
    view.usage = {
      contextUsed: null,
      contextSize: null,
      totalTokens: null,
      inputTokens: null,
      outputTokens: null,
      thoughtTokens: null,
      cost: { amount: 0, currency: "USD" },
    };

    expect(getUsageLabel(view)).toBe("用量");
    expect(getUsageDetailRows(view)).toEqual([
      { id: "cost", label: "累计费用", value: "0 USD" },
    ]);
  });
});

describe("conversation recovery alerts", () => {
  const runtime: RuntimeSnapshot = {
    phase: "error",
    permissionMode: "default",
    xaiApiBaseUrl: null,
    xaiApiKeyConfigured: false,
    mcpConfigured: false,
    reportedMcpServerCount: 0,
    reportedMcpServerCountTruncated: false,
    workspacePath: "D:\\project",
    executablePath: "D:\\grok.exe",
    grokVersion: "0.2.101",
    protocolVersion: 1,
    currentModelId: null,
    availableModels: [],
    authMethods: [],
    capabilities: createEmptyRuntimeCapabilities(),
    sessionExecutions: [],
    message: "ACP transport closed",
  };

  it("keeps runtime, persistence, and truncated replay problems independently visible", () => {
    const alerts = getConversationAlerts(runtime, true, true);
    expect(alerts.map((alert) => alert.id)).toEqual([
      "runtime-error",
      "base-url-persistence",
      "replay-truncated",
    ]);
    expect(alerts[0]).toMatchObject({
      detail: "ACP transport closed",
      reconnect: true,
      settings: true,
      dismissible: false,
    });
    expect(alerts[2]).toMatchObject({ dismissible: true, reconnect: false });
  });

  it("does not show recovery alerts for a healthy synchronized task", () => {
    expect(getConversationAlerts({ ...runtime, phase: "ready", message: null }, false, false)).toEqual([]);
  });
});

describe("active session model presentation", () => {
  const runtime: RuntimeSnapshot = {
    phase: "ready",
    permissionMode: "default",
    xaiApiBaseUrl: null,
    xaiApiKeyConfigured: false,
    mcpConfigured: false,
    reportedMcpServerCount: 0,
    reportedMcpServerCountTruncated: false,
    workspacePath: "D:\\project",
    executablePath: "D:\\grok.exe",
    grokVersion: "0.2.101",
    protocolVersion: 1,
    currentModelId: "runtime-model",
    availableModels: [{ id: "runtime-model", name: "Runtime model" }],
    authMethods: [],
    capabilities: createEmptyRuntimeCapabilities(),
    sessionExecutions: [],
    message: null,
  };

  it("prefers the active session model over the process-wide runtime snapshot", () => {
    const view = createEmptySessionView();
    view.configOptions = [{
      id: "model",
      name: "Model",
      type: "select",
      category: "model",
      currentValue: "session-model",
      readOnly: true,
      options: [{ value: "session-model", name: "Session model" }],
    }];

    expect(getActiveModelLabel(view, runtime)).toBe("Session model");
  });

  it("falls back to the advertised runtime model name", () => {
    expect(getActiveModelLabel(undefined, runtime)).toBe("Runtime model");
  });
});

describe("composer context files", () => {
  it("deduplicates Windows paths and preserves the picker order", () => {
    const first = {
      path: "D:\\project\\src\\main.ts",
      name: "main.ts",
      relativePath: "src\\main.ts",
      size: 100,
    };
    const second = {
      path: "D:\\project\\README.md",
      name: "README.md",
      relativePath: "README.md",
      size: 200,
    };

    expect(mergeContextFiles([first], [
      { ...first, path: "d:\\PROJECT\\src\\main.ts" },
      second,
    ])).toEqual([first, second]);
  });
});

describe("conversation timeline following", () => {
  it("keeps following only while the reader remains near the latest message", () => {
    expect(isTimelineNearBottom({ scrollHeight: 1_000, scrollTop: 510, clientHeight: 400 })).toBe(true);
    expect(isTimelineNearBottom({ scrollHeight: 1_000, scrollTop: 300, clientHeight: 400 })).toBe(false);
    expect(isTimelineNearBottom({ scrollHeight: 300, scrollTop: 0, clientHeight: 400 })).toBe(true);
  });
});
