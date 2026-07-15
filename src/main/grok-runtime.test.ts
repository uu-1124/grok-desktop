import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type {
  DesktopEvent,
  McpServerConfig,
  RuntimeSnapshot,
  SessionExecutionSnapshot,
} from "../shared/contracts";
import { createEmptyRuntimeCapabilities } from "../shared/contracts";
import {
  assertAdvertisedModelSelection,
  assertAdvertisedReasoningEffort,
  assertStdioMcpExecutionApproved,
  GrokRuntime,
  mcpEnvironmentMaskFromLaunch,
  outcomeFromStopReason,
  requireMcpExecutablePath,
  toAcpMcpServers,
} from "./grok-runtime";
import { buildGrokAgentLaunch } from "./grok-launch";

describe("Grok turn stop reasons", () => {
  it.each([
    "end_turn",
    "max_tokens",
    "max_turn_requests",
    "refusal",
    "cancelled",
  ] as const)("preserves the ACP stop reason %s", (stopReason) => {
    expect(outcomeFromStopReason(stopReason)).toBe(stopReason);
  });

  it("rejects unknown stop reasons instead of reporting successful completion", () => {
    expect(() => outcomeFromStopReason("unexpected_reason")).toThrow(
      "Unsupported Grok stop reason",
    );
  });
});

describe("Grok renderer redaction boundary", () => {
  it("keeps internal and emitted control fields valid when a secret collides with protocol text", () => {
    const events: DesktopEvent[] = [];
    const runtime = new GrokRuntime((event) => events.push(event));
    const internals = runtime as unknown as {
      sensitiveValues: string[];
      updateSnapshot(patch: Partial<RuntimeSnapshot>): void;
      emitEvent(event: DesktopEvent): void;
    };
    internals.sensitiveValues = ["ready", "runtime", "session-update"];

    internals.updateSnapshot({
      phase: "ready",
      message: "runtime ready",
    });
    internals.emitEvent({
      type: "session-update",
      sessionId: "session-1",
      update: {
        sessionUpdate: "session-update",
        output: "runtime ready",
      },
      receivedAt: "2026-07-15T00:00:00.000Z",
    });

    expect((runtime as unknown as { snapshot: RuntimeSnapshot }).snapshot).toMatchObject({
      phase: "ready",
      message: "runtime ready",
    });
    expect(runtime.getSnapshot()).toMatchObject({
      phase: "ready",
      message: "[REDACTED] [REDACTED]",
    });
    expect(events[0]).toMatchObject({
      type: "runtime",
      snapshot: { phase: "ready", message: "[REDACTED] [REDACTED]" },
    });
    expect(events[1]).toMatchObject({
      type: "session-update",
      update: {
        sessionUpdate: "session-update",
        output: "[REDACTED] [REDACTED]",
      },
    });
  });

  it("exposes only the active API key presence bit and clears it during teardown", async () => {
    const runtime = new GrokRuntime(() => undefined);
    const internals = runtime as unknown as {
      xaiApiKeyConfigured: boolean;
      updateSnapshot(patch: Partial<RuntimeSnapshot>): void;
      teardownConnection(): Promise<void>;
    };
    internals.xaiApiKeyConfigured = true;
    internals.updateSnapshot({
      phase: "ready",
      xaiApiBaseUrl: "https://gateway.example.com/v1",
    });

    expect(runtime.getSnapshot()).toMatchObject({
      xaiApiBaseUrl: "https://gateway.example.com/v1",
      xaiApiKeyConfigured: true,
    });
    await internals.teardownConnection();
    expect(runtime.getSnapshot().xaiApiKeyConfigured).toBe(false);
  });

  it("clears the API key presence bit when the active runtime fails", () => {
    const runtime = new GrokRuntime(() => undefined);
    const internals = runtime as unknown as {
      xaiApiKeyConfigured: boolean;
      failRuntime(reason: string): void;
    };
    internals.xaiApiKeyConfigured = true;

    internals.failRuntime("The Grok ACP connection failed.");

    expect(runtime.getSnapshot().xaiApiKeyConfigured).toBe(false);
  });

  it("rejects reflected API credentials before model metadata reaches renderer state", () => {
    const events: DesktopEvent[] = [];
    const runtime = new GrokRuntime((event) => events.push(event));
    const internals = runtime as unknown as {
      xaiApiKey: string | null;
      applyParsedSessionCapabilities(state: {
        currentModelId: string | null;
        availableModels: Array<{ id: string; name: string }>;
        configOptions: [];
      }): void;
    };
    internals.xaiApiKey = "runtime-reflection-key";

    expect(() => internals.applyParsedSessionCapabilities({
      currentModelId: "model-runtime-reflection-key",
      availableModels: [{ id: "safe-model", name: "Safe model" }],
      configOptions: [],
    })).toThrow(/credentials/u);
    expect(runtime.getSnapshot().availableModels).toEqual([]);
    expect(events).toEqual([]);
  });
});

describe("Grok session loading", () => {
  it("uses a local fallback title only until Grok supplies its native session title", async () => {
    const runtime = new GrokRuntime(() => undefined);
    attachFakeAgent(runtime, async (method) => {
      if (method === "session/new") return { sessionId: "session-title" };
      throw new Error(`Unexpected method: ${method}`);
    });

    const created = await runtime.createSession("修复问题");
    expect(created.title).toBe("修复问题");

    emitFakeUpdate(runtime, "session-title", {
      sessionUpdate: "session_info_update",
      title: "Grok 原生任务标题",
    });

    expect(runtime.getSessions()).toEqual([
      expect.objectContaining({
        sessionId: "session-title",
        title: "Grok 原生任务标题",
      }),
    ]);
  });

  it("stages history updates, restores the xAI title, and avoids loading a mounted session twice", async () => {
    const events: DesktopEvent[] = [];
    const runtime = new GrokRuntime((event) => events.push(event), {
      now: () => new Date("2026-07-14T03:00:00.000Z"),
    });
    let requestCount = 0;
    attachFakeAgent(runtime, async () => {
      requestCount += 1;
      emitFakeHistory(runtime, "session-1");
      expect(events.some((event) => event.type === "session-update")).toBe(false);
      return {
        _meta: {
          "x.ai/sessionDetail": { title: "真实 Grok 任务标题" },
        },
      };
    });

    const first = await runtime.loadSession("session-1", "本地备用标题");
    const updateIndex = events.findIndex((event) => event.type === "session-update");
    const readyIndex = events.findIndex((event) => event.type === "session-ready");
    expect(first.title).toBe("真实 Grok 任务标题");
    expect(updateIndex).toBeGreaterThanOrEqual(0);
    expect(readyIndex).toBeGreaterThan(updateIndex);

    const second = await runtime.loadSession("session-1", "本地备用标题");
    expect(second.title).toBe("真实 Grok 任务标题");
    expect(requestCount).toBe(1);
    expect(events.filter((event) => event.type === "session-update")).toHaveLength(1);
  });

  it("discards partial history and provisional session state when loading fails", async () => {
    const events: DesktopEvent[] = [];
    const runtime = new GrokRuntime((event) => events.push(event));
    attachFakeAgent(runtime, async () => {
      emitFakeHistory(runtime, "session-failed");
      throw new Error("simulated load failure");
    });

    await expect(runtime.loadSession("session-failed", "失败任务")).rejects.toThrow(
      "Unable to load the Grok session",
    );
    expect(events.some((event) => event.type === "session-update")).toBe(false);
    expect(runtime.getSessions()).toEqual([]);
  });
});

describe("Grok MCP session configuration", () => {
  it("requires explicit Main-process consent before accepting stdio MCP", () => {
    const stdio: McpServerConfig[] = [{
      type: "stdio",
      name: "Local tools",
      command: process.execPath,
      args: [],
      env: [],
    }];
    expect(() => assertStdioMcpExecutionApproved(stdio, undefined)).toThrow(
      "Local MCP execution was not approved",
    );
    expect(() => assertStdioMcpExecutionApproved(stdio, true)).not.toThrow();
  });

  it("maps stdio to the ACP shape without a type field and masks the Grok environment", () => {
    const result = toAcpMcpServers([{
      type: "stdio",
      name: "Local tools",
      command: process.execPath,
      args: ["--project", "D:\\workspace with spaces"],
      env: [{ name: "PROJECT_TOKEN", value: "explicit-secret" }],
    }], {
      Path: "C:\\Windows",
      XAI_API_KEY: "ui-entered-secret",
      PARENT_TOKEN: "parent-secret",
    }, "win32");

    expect(result).toEqual([{
      name: "Local tools",
      command: process.execPath,
      args: ["--project", "D:\\workspace with spaces"],
      env: [
        { name: "PROJECT_TOKEN", value: "explicit-secret" },
        { name: "GROK_CODE_XAI_API_KEY", value: "" },
        { name: "PARENT_TOKEN", value: "" },
        { name: "XAI_API_KEY", value: "" },
      ],
    }]);
    expect(result[0]).not.toHaveProperty("type");
  });

  it("derives the stdio mask from the actual Grok launch environment without copying values", () => {
    const launch = buildGrokAgentLaunch({
      modelId: null,
      permissionMode: "default",
      xaiApiBaseUrl: "https://gateway.example.com/v1",
      xaiApiKey: "ui-only-xai-secret",
    }, { Path: "C:\\Windows" });
    const mask = mcpEnvironmentMaskFromLaunch(launch.env);

    expect(mask).toHaveProperty("XAI_API_KEY");
    expect(mask.XAI_API_KEY).toBeUndefined();
    expect(JSON.stringify(mask)).not.toContain("ui-only-xai-secret");

    const result = toAcpMcpServers([{
      type: "stdio",
      name: "Local tools",
      command: process.execPath,
      args: [],
      env: [],
    }], mask, "win32");
    expect(result[0]?.env).toContainEqual({ name: "XAI_API_KEY", value: "" });
  });

  it("lets explicit stdio environment override an inherited key without duplicates", () => {
    const result = toAcpMcpServers([{
      type: "stdio",
      name: "Explicit key",
      command: process.execPath,
      args: [],
      env: [{ name: "XAI_API_KEY", value: "explicit-for-this-server" }],
    }], {}, "win32");
    expect(result[0]?.env).toEqual([
      { name: "XAI_API_KEY", value: "explicit-for-this-server" },
      { name: "GROK_CODE_XAI_API_KEY", value: "" },
    ]);
  });

  it("revalidates and forwards one isolated stdio configuration to new and loaded sessions", async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const runtime = new GrokRuntime(() => undefined);
    attachFakeAgent(runtime, async (method, params) => {
      requests.push({ method, params });
      if (method === "session/new") return { sessionId: "session-stdio-new" };
      if (method === "session/load") return {};
      throw new Error(`Unexpected method: ${method}`);
    });
    Object.assign(runtime as object, {
      mcpServers: [{
        type: "stdio",
        name: "Local tools",
        command: process.execPath,
        args: ["D:\\mock server.mjs", "--flag=value with spaces"],
        env: [{ name: "MCP_TOKEN", value: "memory-only" }],
      }],
      mcpInheritedEnvironment: {
        Path: undefined,
        XAI_API_KEY: undefined,
        PARENT_SECRET: undefined,
      },
    });

    await runtime.createSession("stdio new");
    await runtime.loadSession("session-stdio-loaded", "stdio loaded");

    for (const request of requests) {
      expect((request.params as { mcpServers: unknown }).mcpServers).toEqual([{
        name: "Local tools",
        command: await requireMcpExecutablePath(process.execPath),
        args: ["D:\\mock server.mjs", "--flag=value with spaces"],
        env: [
          { name: "MCP_TOKEN", value: "memory-only" },
          { name: "GROK_CODE_XAI_API_KEY", value: "" },
          { name: "PARENT_SECRET", value: "" },
          { name: "XAI_API_KEY", value: "" },
        ],
      }]);
    }
  });

  it("accepts only a local direct executable for stdio MCP", async () => {
    await expect(requireMcpExecutablePath(process.execPath)).resolves.toBeTruthy();
    if (process.platform === "win32") {
      await expect(requireMcpExecutablePath("\\\\server\\share\\mcp.exe")).rejects.toThrow("本机磁盘");
      await expect(requireMcpExecutablePath(pathToFileURL(import.meta.url).pathname)).rejects.toThrow();
    }
  });

  it("redacts stdio command, argument, and environment values from session failures", async () => {
    const runtime = new GrokRuntime(() => undefined);
    attachFakeAgent(runtime, async () => {
      throw new Error(
        `${process.execPath} failed for --token=argument-secret with environment-secret`,
      );
    });
    Object.assign(runtime as object, {
      mcpServers: [{
        type: "stdio",
        name: "Local tools",
        command: process.execPath,
        args: ["--token=argument-secret"],
        env: [{ name: "MCP_TOKEN", value: "environment-secret" }],
      }],
      mcpInheritedEnvironment: {},
      sensitiveValues: [process.execPath, "--token=argument-secret", "environment-secret"],
    });

    let message = "";
    try {
      await runtime.createSession("redaction");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("[REDACTED]");
    expect(message).not.toContain("argument-secret");
    expect(message).not.toContain("environment-secret");
    expect(message).not.toContain(process.execPath);
  });

  it("forwards an isolated copy to both new and loaded sessions", async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const runtime = new GrokRuntime(() => undefined);
    attachFakeAgent(runtime, async (method, params) => {
      requests.push({ method, params });
      if (method === "session/new") return { sessionId: "session-mcp-new" };
      if (method === "session/load") return {};
      throw new Error(`Unexpected method: ${method}`);
    });
    Object.assign(runtime as object, {
      mcpServers: [{
        type: "http",
        name: "Project tools",
        url: "https://mcp.example.com/api",
        headers: [{ name: "Authorization", value: "Bearer memory-only" }],
      }],
    });

    await runtime.createSession("MCP new session");
    await runtime.loadSession("session-mcp-loaded", "MCP loaded session");

    expect(requests.map(({ method, params }) => ({
      method,
      mcpServers: (params as { mcpServers: unknown }).mcpServers,
    }))).toEqual([
      {
        method: "session/new",
        mcpServers: [{
          type: "http",
          name: "Project tools",
          url: "https://mcp.example.com/api",
          headers: [{ name: "Authorization", value: "Bearer memory-only" }],
        }],
      },
      {
        method: "session/load",
        mcpServers: [{
          type: "http",
          name: "Project tools",
          url: "https://mcp.example.com/api",
          headers: [{ name: "Authorization", value: "Bearer memory-only" }],
        }],
      },
    ]);

    const firstHeaders = (requests[0]?.params as {
      mcpServers: Array<{ headers: Array<{ value: string }> }>;
    }).mcpServers[0]?.headers;
    if (firstHeaders?.[0]) firstHeaders[0].value = "mutated";
    expect((runtime as unknown as {
      mcpServers: Array<{ headers: Array<{ value: string }> }>;
    }).mcpServers[0]?.headers[0]?.value).toBe("Bearer memory-only");
  });

  it("maps an advertised SSE server into the ACP session request", async () => {
    const requests: unknown[] = [];
    const runtime = new GrokRuntime(() => undefined);
    attachFakeAgent(runtime, async (method, params) => {
      if (method !== "session/new") throw new Error(`Unexpected method: ${method}`);
      requests.push(params);
      return { sessionId: "session-mcp-sse" };
    });
    Object.assign(runtime as object, {
      mcpServers: [{
        type: "sse",
        name: "Project events",
        url: "https://mcp.example.com/events",
        headers: [{ name: "X-Project-Token", value: "memory-only-sse" }],
      }],
    });

    await runtime.createSession("MCP SSE session");

    expect((requests[0] as { mcpServers: unknown }).mcpServers).toEqual([{
      type: "sse",
      name: "Project events",
      url: "https://mcp.example.com/events",
      headers: [{ name: "X-Project-Token", value: "memory-only-sse" }],
    }]);
  });

  it("clears MCP configuration and redaction values on disconnect", async () => {
    const runtime = new GrokRuntime(() => undefined);
    const internal = runtime as unknown as {
      mcpServers: McpServerConfig[];
      mcpInheritedEnvironment: Record<string, string | undefined>;
      sensitiveValues: string[];
    };
    internal.mcpServers = [{
      type: "http",
      name: "Temporary tools",
      url: "https://mcp.example.com/",
      headers: [{ name: "Authorization", value: "Bearer temporary-secret" }],
    }];
    internal.sensitiveValues = ["Bearer temporary-secret", "temporary-secret"];
    internal.mcpInheritedEnvironment = { XAI_API_KEY: undefined };

    expect(runtime.getSnapshot().mcpConfigured).toBe(true);
    expect(JSON.stringify(runtime.getSnapshot())).not.toContain("Temporary tools");

    await runtime.disconnect();

    expect(internal.mcpServers).toEqual([]);
    expect(internal.mcpInheritedEnvironment).toEqual({});
    expect(internal.sensitiveValues).toEqual([]);
    expect(runtime.getSnapshot().mcpConfigured).toBe(false);
  });

  it("keeps Grok-managed MCP updates to a non-sensitive runtime count", () => {
    const events: DesktopEvent[] = [];
    const runtime = new GrokRuntime((event) => events.push(event));
    const internal = runtime as unknown as {
      handleReportedMcpServers(notification: unknown): void;
    };

    internal.handleReportedMcpServers({
      mcpServers: [
        { name: "local", command: "C:\\secret\\server.exe", headers: [{ value: "memory-secret" }] },
        { name: "remote", url: "https://mcp.example.com/private" },
      ],
    });

    expect(runtime.getSnapshot().reportedMcpServerCount).toBe(2);
    expect(runtime.getSnapshot().reportedMcpServerCountTruncated).toBe(false);
    expect(JSON.stringify({ snapshot: runtime.getSnapshot(), events })).not.toContain("memory-secret");
    expect(JSON.stringify({ snapshot: runtime.getSnapshot(), events })).not.toContain("mcp.example.com");

    const eventCount = events.length;
    internal.handleReportedMcpServers({ mcpServers: "invalid" });
    internal.handleReportedMcpServers({ mcpServers: [null, "invalid"] });
    internal.handleReportedMcpServers({ unexpected: [] });
    internal.handleReportedMcpServers({ mcpServers: [{ name: "different details" }, {}] });
    expect(events).toHaveLength(eventCount);

    internal.handleReportedMcpServers({
      mcpServers: Array.from({ length: 300 }, () => ({})),
    });
    expect(runtime.getSnapshot().reportedMcpServerCount).toBe(256);
    expect(runtime.getSnapshot().reportedMcpServerCountTruncated).toBe(true);

    internal.handleReportedMcpServers({ mcpServers: [] });
    expect(runtime.getSnapshot().reportedMcpServerCount).toBe(0);
    expect(runtime.getSnapshot().reportedMcpServerCountTruncated).toBe(false);
  });

  it("clears Grok-managed MCP status on disconnect", async () => {
    const runtime = new GrokRuntime(() => undefined);
    const internal = runtime as unknown as {
      handleReportedMcpServers(notification: unknown): void;
    };
    internal.handleReportedMcpServers({ mcpServers: [{}, {}] });

    await runtime.disconnect();

    expect(runtime.getSnapshot().reportedMcpServerCount).toBe(0);
    expect(runtime.getSnapshot().reportedMcpServerCountTruncated).toBe(false);
  });

  it("redacts MCP credentials from failed execution snapshots and events", () => {
    const events: DesktopEvent[] = [];
    const runtime = new GrokRuntime((event) => events.push(event), {
      now: () => new Date("2026-07-14T06:00:00.000Z"),
    });
    const internal = runtime as unknown as {
      executions: Map<string, SessionExecutionSnapshot>;
      sensitiveValues: string[];
      failRuntime(reason: string): void;
    };
    internal.sensitiveValues = ["Bearer mcp-secret", "mcp-secret"];
    internal.executions.set("session-secret", {
      sessionId: "session-secret",
      phase: "working",
      turnId: "turn-secret",
      startedAt: "2026-07-14T05:59:00.000Z",
      finishedAt: null,
      stopReason: null,
      error: null,
      pendingPermissionCount: 0,
    });

    internal.failRuntime("Grok rejected credential mcp-secret");

    const serialized = JSON.stringify({ snapshot: runtime.getSnapshot(), events });
    expect(serialized).not.toContain("mcp-secret");
    expect(serialized).toContain("[REDACTED]");
    expect(runtime.getSnapshot().sessionExecutions[0]?.error).toBe(
      "Grok rejected credential [REDACTED]",
    );
    expect(internal.sensitiveValues).toEqual([]);
  });
});

describe("Grok prompt usage", () => {
  it("projects prompt-response usage into a renderer-safe usage update", async () => {
    const events: DesktopEvent[] = [];
    const runtime = new GrokRuntime((event) => events.push(event), {
      now: () => new Date("2026-07-14T03:10:00.000Z"),
      createId: () => "turn-usage",
    });
    attachFakeAgent(runtime, async (method) => {
      if (method === "session/new") return { sessionId: "session-usage" };
      if (method === "session/prompt") {
        return {
          stopReason: "end_turn",
          usage: {
            totalTokens: 1_500,
            inputTokens: 1_100,
            outputTokens: 300,
            thoughtTokens: 100,
          },
        };
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    await runtime.createSession("Usage test");
    events.length = 0;
    await runtime.prompt({ sessionId: "session-usage", text: "test usage" });

    const usageEvent = events.find((event) =>
      event.type === "session-update" && event.update.sessionUpdate === "usage_update",
    );
    expect(usageEvent).toMatchObject({
      type: "session-update",
      sessionId: "session-usage",
      update: {
        usage: {
          totalTokens: 1_500,
          inputTokens: 1_100,
          outputTokens: 300,
          thoughtTokens: 100,
        },
      },
    });
  });

  it("sends selected workspace files as ACP resource links without embedding contents", async () => {
    let promptParams: Record<string, unknown> | undefined;
    const runtime = new GrokRuntime(() => undefined, {
      createId: () => "turn-context",
    });
    attachFakeAgent(runtime, async (method, params) => {
      if (method === "session/new") return { sessionId: "session-context" };
      if (method === "session/prompt") {
        promptParams = params as Record<string, unknown>;
        return { stopReason: "end_turn" };
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    await runtime.createSession("Context test");
    const contextPath = path.join("D:\\project", "src", "main.ts");
    await runtime.prompt({
      sessionId: "session-context",
      text: "Review this file",
      contextPaths: [contextPath],
    });

    expect(promptParams).toEqual({
      sessionId: "session-context",
      prompt: [
        { type: "text", text: "Review this file" },
        {
          type: "resource_link",
          uri: pathToFileURL(contextPath).href,
          name: "main.ts",
        },
      ],
    });
    expect(JSON.stringify(promptParams)).not.toContain("export {};");
  });

  it("embeds prepared text only when Grok advertises embedded context", async () => {
    let promptParams: Record<string, unknown> | undefined;
    const runtime = new GrokRuntime(() => undefined, {
      createId: () => "turn-embedded-context",
    });
    attachFakeAgent(runtime, async (method, params) => {
      if (method === "session/new") return { sessionId: "session-context" };
      if (method === "session/prompt") {
        promptParams = params as Record<string, unknown>;
        return { stopReason: "end_turn" };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const snapshot = runtime.getSnapshot();
    Object.assign(runtime as object, {
      snapshot: {
        ...snapshot,
        capabilities: {
          ...snapshot.capabilities,
          prompt: {
            ...snapshot.capabilities.prompt,
            embeddedContext: true,
          },
        },
      },
    });

    await runtime.createSession("Embedded context test");
    const contextPath = path.join("D:\\project", "package.json");
    await runtime.prompt({
      sessionId: "session-context",
      text: "Read this file",
      contextPaths: [contextPath],
    }, [{
      path: contextPath,
      name: "package.json",
      relativePath: "package.json",
      size: 23,
      text: '{"name":"grok-desktop"}',
      mimeType: "application/json",
    }]);

    expect(promptParams).toEqual({
      sessionId: "session-context",
      prompt: [
        { type: "text", text: "Read this file" },
        {
          type: "resource",
          resource: {
            uri: pathToFileURL(contextPath).href,
            text: '{"name":"grok-desktop"}',
            mimeType: "application/json",
          },
        },
      ],
    });
  });

  it("removes embedded file bodies before prompt echoes cross into the renderer", async () => {
    const events: DesktopEvent[] = [];
    const runtime = new GrokRuntime((event) => events.push(event));
    attachFakeAgent(runtime, async (method) => {
      if (method === "session/new") return { sessionId: "session-context" };
      throw new Error(`Unexpected method: ${method}`);
    });
    await runtime.createSession("Sanitized context echo");
    events.length = 0;

    emitFakeUpdate(runtime, "session-context", {
      sessionUpdate: "user_message_chunk",
      content: {
        type: "resource",
        resource: {
          uri: "file:///D:/project/secret.ts",
          mimeType: "text/typescript",
          text: "do-not-cross-the-preload-boundary",
        },
      },
    });

    const update = events.find((event) => event.type === "session-update");
    expect(update).toMatchObject({
      type: "session-update",
      update: {
        content: {
          type: "resource",
          resource: {
            uri: "file:///D:/project/secret.ts",
            mimeType: "text/typescript",
          },
        },
      },
    });
    expect(JSON.stringify(update)).not.toContain("do-not-cross-the-preload-boundary");
  });

  it("rejects forged prompt resource paths outside the connected workspace", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "session/new") return { sessionId: "session-context" };
      if (method === "session/prompt") return { stopReason: "end_turn" };
      throw new Error(`Unexpected method: ${method}`);
    });
    const runtime = new GrokRuntime(() => undefined, {
      createId: () => "turn-context",
    });
    attachFakeAgent(runtime, request);
    await runtime.createSession("Context boundary");

    await expect(runtime.prompt({
      sessionId: "session-context",
      text: "Review this file",
      contextPaths: [path.join("D:\\outside", "secret.txt")],
    })).rejects.toThrow("inside the current workspace");
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe("Grok model selection boundary", () => {
  const snapshot: RuntimeSnapshot = {
    phase: "ready",
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
    currentModelId: "grok-build",
    availableModels: [
      {
        id: "grok-build",
        name: "Grok Build",
        reasoningEfforts: [
          { id: "low", name: "Low", isDefault: false },
          { id: "high", name: "High", isDefault: true },
        ],
      },
      { id: "--leading-dash", name: "Unusual but advertised" },
    ],
    authMethods: [],
    capabilities: createEmptyRuntimeCapabilities(),
    sessionExecutions: [],
    message: null,
  };

  it("accepts only a model advertised by the same Grok executable", () => {
    expect(() => assertAdvertisedModelSelection(
      "grok-build",
      "D:\\grok.exe",
      snapshot,
    )).not.toThrow();
    expect(() => assertAdvertisedModelSelection(
      "--leading-dash",
      "D:\\grok.exe",
      snapshot,
    )).not.toThrow();
  });

  it("rejects stale, invented, or cross-executable model selections", () => {
    expect(() => assertAdvertisedModelSelection(
      "invented-model",
      "D:\\grok.exe",
      snapshot,
    )).toThrow(/not advertised/u);
    expect(() => assertAdvertisedModelSelection(
      "grok-build",
      "D:\\other-grok.exe",
      snapshot,
    )).toThrow(/not advertised/u);
  });

  it("accepts only a reasoning effort advertised by the selected model", () => {
    expect(() => assertAdvertisedReasoningEffort(
      "high",
      "grok-build",
      "D:\\grok.exe",
      snapshot,
    )).not.toThrow();
    expect(() => assertAdvertisedReasoningEffort(
      "balanced",
      "grok-build",
      "D:\\grok.exe",
      snapshot,
    )).toThrow(/reasoning effort/u);
    expect(() => assertAdvertisedReasoningEffort(
      "high",
      null,
      "D:\\grok.exe",
      snapshot,
    )).toThrow(/reasoning effort/u);
    expect(() => assertAdvertisedReasoningEffort(
      "high",
      "grok-build",
      "D:\\other-grok.exe",
      snapshot,
    )).toThrow(/reasoning effort/u);
  });
});

describe("Grok turn cancellation", () => {
  it("writes session/cancel before resolving pending permission requests", async () => {
    const order: string[] = [];
    const runtime = createCancellationRuntime(
      () => new Promise<Record<string, unknown>>(() => undefined),
      async () => { order.push("cancel-notification"); },
    );

    await runtime.createSession("Cancel order");
    void runtime.prompt({ sessionId: "session-cancel", text: "keep working" });
    const permission = requestFakePermission(runtime, "session-cancel");
    void permission.then(() => order.push("permission-cancelled"));

    await runtime.cancel("session-cancel");
    await Promise.resolve();

    expect(order).toEqual(["cancel-notification", "permission-cancelled"]);
    await runtime.disconnect();
  });

  it("fails closed when the cancel notification cannot be written", async () => {
    const events: DesktopEvent[] = [];
    const runtime = createCancellationRuntime(
      () => new Promise<Record<string, unknown>>(() => undefined),
      async () => { throw new Error("simulated cancel transport failure"); },
      events,
    );

    await runtime.createSession("Cancel failure");
    void runtime.prompt({ sessionId: "session-cancel", text: "keep working" });
    const permission = requestFakePermission(runtime, "session-cancel");

    await expect(runtime.cancel("session-cancel")).rejects.toThrow(
      "Unable to cancel the Grok prompt",
    );
    await expect(permission).resolves.toEqual({ outcome: { outcome: "cancelled" } });
    expect(runtime.getSnapshot()).toMatchObject({
      phase: "error",
      sessionExecutions: [{ phase: "failed" }],
    });
    expect(events).toContainEqual(expect.objectContaining({ type: "notice", level: "error" }));
  });

  it("stops the runtime when Grok does not confirm cancellation", async () => {
    vi.useFakeTimers();
    try {
      const events: DesktopEvent[] = [];
      const runtime = createCancellationRuntime(
        () => new Promise<Record<string, unknown>>(() => undefined),
        async () => undefined,
        events,
        50,
      );

      await runtime.createSession("Cancel timeout");
      void runtime.prompt({ sessionId: "session-cancel", text: "keep working" });
      await runtime.cancel("session-cancel");
      await vi.advanceTimersByTimeAsync(50);

      expect(runtime.getSnapshot()).toMatchObject({
        phase: "error",
        sessionExecutions: [{ phase: "failed" }],
      });
      expect(events).toContainEqual(expect.objectContaining({
        type: "notice",
        level: "error",
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the watchdog after Grok confirms cancellation", async () => {
    vi.useFakeTimers();
    try {
      let finishPrompt: ((value: Record<string, unknown>) => void) | undefined;
      const prompt = new Promise<Record<string, unknown>>((resolve) => {
        finishPrompt = resolve;
      });
      const runtime = createCancellationRuntime(
        () => prompt,
        async () => undefined,
        [],
        50,
      );

      await runtime.createSession("Confirmed cancel");
      const turn = runtime.prompt({ sessionId: "session-cancel", text: "keep working" });
      await runtime.cancel("session-cancel");
      finishPrompt?.({ stopReason: "cancelled" });
      await turn;
      expect(cancelInternals(runtime).cancelWatchdogs.size).toBe(0);
      expect(cancelInternals(runtime).activeCancellations.size).toBe(0);
      await vi.advanceTimersByTimeAsync(50);

      expect(runtime.getSnapshot()).toMatchObject({
        phase: "ready",
        sessionExecutions: [{ phase: "cancelled" }],
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the cancellation watchdog when the user force-disconnects", async () => {
    vi.useFakeTimers();
    try {
      const events: DesktopEvent[] = [];
      const runtime = createCancellationRuntime(
        () => new Promise<Record<string, unknown>>(() => undefined),
        async () => undefined,
        events,
        50,
      );

      await runtime.createSession("Force disconnect");
      void runtime.prompt({ sessionId: "session-cancel", text: "keep working" });
      await runtime.cancel("session-cancel");
      const disconnect = runtime.disconnect();
      await vi.advanceTimersByTimeAsync(0);
      await disconnect;
      expect(cancelInternals(runtime).cancelWatchdogs.size).toBe(0);
      expect(cancelInternals(runtime).activeCancellations.size).toBe(0);
      events.length = 0;
      await vi.advanceTimersByTimeAsync(50);

      expect(runtime.getSnapshot().phase).toBe("offline");
      expect(events.some((event) =>
        event.type === "notice" && event.message.includes("did not confirm cancellation")
      )).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a late cancellation response after the watchdog has failed the runtime", async () => {
    vi.useFakeTimers();
    try {
      const events: DesktopEvent[] = [];
      let finishPrompt: ((value: Record<string, unknown>) => void) | undefined;
      const prompt = new Promise<Record<string, unknown>>((resolve) => {
        finishPrompt = resolve;
      });
      const runtime = createCancellationRuntime(
        () => prompt,
        async () => undefined,
        events,
        50,
      );

      await runtime.createSession("Late cancellation response");
      const turn = runtime.prompt({ sessionId: "session-cancel", text: "keep working" });
      await runtime.cancel("session-cancel");
      await vi.advanceTimersByTimeAsync(50);
      finishPrompt?.({ stopReason: "cancelled" });
      await turn;

      expect(runtime.getSnapshot()).toMatchObject({
        phase: "error",
        sessionExecutions: [{ phase: "failed" }],
      });
      expect(events.some((event) => event.type === "turn-complete")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a late prompt rejection after the cancellation watchdog has failed the runtime", async () => {
    vi.useFakeTimers();
    try {
      const events: DesktopEvent[] = [];
      let rejectPrompt: ((error: Error) => void) | undefined;
      const prompt = new Promise<Record<string, unknown>>((_resolve, reject) => {
        rejectPrompt = reject;
      });
      const runtime = createCancellationRuntime(
        () => prompt,
        async () => undefined,
        events,
        50,
      );

      await runtime.createSession("Late prompt rejection");
      const turn = runtime.prompt({ sessionId: "session-cancel", text: "keep working" });
      await runtime.cancel("session-cancel");
      await vi.advanceTimersByTimeAsync(50);
      rejectPrompt?.(new Error("late prompt failure"));
      await turn;

      expect(runtime.getSnapshot()).toMatchObject({
        phase: "error",
        sessionExecutions: [{ phase: "failed" }],
      });
      expect(events.some((event) => event.type === "turn-failed")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("isolates a late response from a disconnected turn from a new turn with the same session id", async () => {
    let finishOldPrompt: ((value: Record<string, unknown>) => void) | undefined;
    let finishNewPrompt: ((value: Record<string, unknown>) => void) | undefined;
    const oldPrompt = new Promise<Record<string, unknown>>((resolve) => {
      finishOldPrompt = resolve;
    });
    const newPrompt = new Promise<Record<string, unknown>>((resolve) => {
      finishNewPrompt = resolve;
    });
    let nextTurn = 0;
    const runtime = new GrokRuntime(() => undefined, {
      cancelTimeoutMs: 1_000,
      createId: () => nextTurn++ === 0 ? "turn-old" : "turn-new",
    });

    attachFakeAgent(runtime, async (method) => {
      if (method === "session/new") return { sessionId: "session-reused" };
      if (method === "session/prompt") return oldPrompt;
      throw new Error(`Unexpected method: ${method}`);
    });
    await runtime.createSession("Old turn");
    const oldTurn = runtime.prompt({ sessionId: "session-reused", text: "old" });

    await runtime.disconnect();
    attachFakeAgent(runtime, async (method) => {
      if (method === "session/new") return { sessionId: "session-reused" };
      if (method === "session/prompt") return newPrompt;
      throw new Error(`Unexpected method: ${method}`);
    });
    await runtime.createSession("New turn");
    const newTurn = runtime.prompt({ sessionId: "session-reused", text: "new" });

    finishOldPrompt?.({ stopReason: "end_turn" });
    await oldTurn;
    await expect(runtime.cancel("session-reused")).resolves.toBeUndefined();

    finishNewPrompt?.({ stopReason: "cancelled" });
    await newTurn;
    expect(runtime.getSnapshot()).toMatchObject({
      phase: "ready",
      sessionExecutions: [{ phase: "cancelled", turnId: "turn-new" }],
    });
    await runtime.disconnect();
  });

  it("blocks the next turn until the previous cancel notification has settled", async () => {
    let finishOldPrompt: ((value: Record<string, unknown>) => void) | undefined;
    let finishNewPrompt: ((value: Record<string, unknown>) => void) | undefined;
    let finishCancelNotification: (() => void) | undefined;
    const oldPrompt = new Promise<Record<string, unknown>>((resolve) => {
      finishOldPrompt = resolve;
    });
    const newPrompt = new Promise<Record<string, unknown>>((resolve) => {
      finishNewPrompt = resolve;
    });
    const cancelNotification = new Promise<void>((resolve) => {
      finishCancelNotification = resolve;
    });
    let promptCount = 0;
    let nextId = 0;
    const runtime = new GrokRuntime(() => undefined, {
      cancelTimeoutMs: 1_000,
      createId: () => `id-${++nextId}`,
    });
    attachFakeAgent(runtime, async (method) => {
      if (method === "session/new") return { sessionId: "session-reused" };
      if (method === "session/prompt") return promptCount++ === 0 ? oldPrompt : newPrompt;
      throw new Error(`Unexpected method: ${method}`);
    }, async () => cancelNotification);

    await runtime.createSession("Delayed cancel");
    const oldTurn = runtime.prompt({ sessionId: "session-reused", text: "old" });
    const cancellation = runtime.cancel("session-reused");
    finishOldPrompt?.({ stopReason: "cancelled" });
    await oldTurn;

    await expect(runtime.prompt({ sessionId: "session-reused", text: "too early" })).rejects.toThrow(
      /cancellation is still in progress/u,
    );
    finishCancelNotification?.();
    await cancellation;

    const newTurn = runtime.prompt({ sessionId: "session-reused", text: "new" });
    const permission = requestFakePermission(runtime, "session-reused");
    expect(runtime.getPendingPermissions()).toHaveLength(1);

    const requestId = runtime.getPendingPermissions()[0]?.requestId;
    expect(requestId).toBeTruthy();
    await runtime.resolvePermission({ requestId: requestId!, optionId: null });
    await expect(permission).resolves.toEqual({ outcome: { outcome: "cancelled" } });
    finishNewPrompt?.({ stopReason: "end_turn" });
    await newTurn;
    await runtime.disconnect();
  });

  it("shares one in-flight cancellation across duplicate stop requests", async () => {
    let finishCancelNotification: (() => void) | undefined;
    const cancelNotification = new Promise<void>((resolve) => {
      finishCancelNotification = resolve;
    });
    const notify = vi.fn(async () => cancelNotification);
    const runtime = createCancellationRuntime(
      () => new Promise<Record<string, unknown>>(() => undefined),
      notify,
    );

    await runtime.createSession("Duplicate cancel");
    void runtime.prompt({ sessionId: "session-cancel", text: "keep working" });
    const first = runtime.cancel("session-cancel");
    const second = runtime.cancel("session-cancel");

    expect(second).toBe(first);
    expect(notify).toHaveBeenCalledTimes(1);
    finishCancelNotification?.();
    await first;
    await runtime.disconnect();
  });

  it("fails closed when writing the cancel notification never settles", async () => {
    vi.useFakeTimers();
    try {
      const events: DesktopEvent[] = [];
      const runtime = createCancellationRuntime(
        () => new Promise<Record<string, unknown>>(() => undefined),
        () => new Promise<void>(() => undefined),
        events,
        50,
      );

      await runtime.createSession("Hung cancel write");
      void runtime.prompt({ sessionId: "session-cancel", text: "keep working" });
      const permission = requestFakePermission(runtime, "session-cancel");
      const cancellation = runtime.cancel("session-cancel");
      await vi.advanceTimersByTimeAsync(50);

      await expect(cancellation).resolves.toBeUndefined();
      await expect(permission).resolves.toEqual({ outcome: { outcome: "cancelled" } });
      expect(runtime.getSnapshot()).toMatchObject({
        phase: "error",
        sessionExecutions: [{ phase: "failed" }],
      });
      expect(cancelInternals(runtime).activeCancellations.size).toBe(0);
      expect(events).toContainEqual(expect.objectContaining({ type: "notice", level: "error" }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses to approve an existing permission after cancellation begins", async () => {
    let finishCancelNotification: (() => void) | undefined;
    const cancelNotification = new Promise<void>((resolve) => {
      finishCancelNotification = resolve;
    });
    const runtime = createCancellationRuntime(
      () => new Promise<Record<string, unknown>>(() => undefined),
      async () => cancelNotification,
    );

    await runtime.createSession("Frozen permission");
    void runtime.prompt({ sessionId: "session-cancel", text: "keep working" });
    const permission = requestFakePermission(runtime, "session-cancel");
    const requestId = runtime.getPendingPermissions()[0]?.requestId;
    expect(requestId).toBeTruthy();
    const cancellation = runtime.cancel("session-cancel");

    await runtime.resolvePermission({ requestId: requestId!, optionId: "allow-once" });
    await expect(permission).resolves.toEqual({ outcome: { outcome: "cancelled" } });
    finishCancelNotification?.();
    await cancellation;
    await runtime.disconnect();
  });

  it("does not let a stale cancel transport failure kill a reconnected runtime", async () => {
    let finishOldPrompt: ((value: Record<string, unknown>) => void) | undefined;
    let finishNewPrompt: ((value: Record<string, unknown>) => void) | undefined;
    let rejectCancelNotification: ((error: Error) => void) | undefined;
    const oldPrompt = new Promise<Record<string, unknown>>((resolve) => {
      finishOldPrompt = resolve;
    });
    const newPrompt = new Promise<Record<string, unknown>>((resolve) => {
      finishNewPrompt = resolve;
    });
    const cancelNotification = new Promise<void>((_resolve, reject) => {
      rejectCancelNotification = reject;
    });
    let nextId = 0;
    const runtime = new GrokRuntime(() => undefined, {
      cancelTimeoutMs: 1_000,
      createId: () => `turn-${++nextId}`,
    });
    attachFakeAgent(runtime, async (method) => {
      if (method === "session/new") return { sessionId: "session-reused" };
      if (method === "session/prompt") return oldPrompt;
      throw new Error(`Unexpected method: ${method}`);
    }, async () => cancelNotification);

    await runtime.createSession("Old runtime");
    const oldTurn = runtime.prompt({ sessionId: "session-reused", text: "old" });
    const cancellation = runtime.cancel("session-reused");
    await runtime.disconnect();

    attachFakeAgent(runtime, async (method) => {
      if (method === "session/new") return { sessionId: "session-reused" };
      if (method === "session/prompt") return newPrompt;
      throw new Error(`Unexpected method: ${method}`);
    });
    await runtime.createSession("New runtime");
    const newTurn = runtime.prompt({ sessionId: "session-reused", text: "new" });

    rejectCancelNotification?.(new Error("stale transport failure"));
    await expect(cancellation).resolves.toBeUndefined();
    expect(runtime.getSnapshot()).toMatchObject({
      phase: "working",
      sessionExecutions: [{ phase: "working" }],
    });

    finishOldPrompt?.({ stopReason: "cancelled" });
    await oldTurn;
    finishNewPrompt?.({ stopReason: "end_turn" });
    await newTurn;
    await runtime.disconnect();
  });

  it("cancels permission requests that arrive after cancellation has started", async () => {
    const events: DesktopEvent[] = [];
    const runtime = createCancellationRuntime(
      () => new Promise<Record<string, unknown>>(() => undefined),
      async () => undefined,
      events,
    );

    await runtime.createSession("Late permission");
    void runtime.prompt({ sessionId: "session-cancel", text: "keep working" });
    await runtime.cancel("session-cancel");
    events.length = 0;

    await expect(requestFakePermission(runtime, "session-cancel")).resolves.toEqual({
      outcome: { outcome: "cancelled" },
    });
    expect(runtime.getPendingPermissions()).toEqual([]);
    expect(events.some((event) => event.type === "permission-request")).toBe(false);
    await runtime.disconnect();
  });

  it("resolves pending permissions as cancelled on direct disconnect", async () => {
    const runtime = createCancellationRuntime(
      () => new Promise<Record<string, unknown>>(() => undefined),
      async () => undefined,
    );

    await runtime.createSession("Disconnect permission");
    void runtime.prompt({ sessionId: "session-cancel", text: "keep working" });
    const permission = requestFakePermission(runtime, "session-cancel");
    await runtime.disconnect();

    await expect(permission).resolves.toEqual({ outcome: { outcome: "cancelled" } });
    expect(runtime.getPendingPermissions()).toEqual([]);
  });
});

function cancelInternals(runtime: GrokRuntime): {
  cancelWatchdogs: Map<string, unknown>;
  activeCancellations: Map<string, unknown>;
} {
  return runtime as unknown as {
    cancelWatchdogs: Map<string, unknown>;
    activeCancellations: Map<string, unknown>;
  };
}

function attachFakeAgent(
  runtime: GrokRuntime,
  request: (method: string, params?: unknown) => Promise<Record<string, unknown>>,
  notify: (method: string, params?: unknown) => Promise<void> = async () => undefined,
): void {
  const snapshot = {
    ...runtime.getSnapshot(),
    phase: "ready" as const,
    workspacePath: "D:\\project",
    capabilities: {
      ...runtime.getSnapshot().capabilities,
      session: {
        ...runtime.getSnapshot().capabilities.session,
        load: true,
      },
    },
  };
  Object.assign(runtime as object, {
    snapshot,
    agent: { notify, request },
    connection: { close: () => undefined, signal: new AbortController().signal },
  });
}

function createCancellationRuntime(
  prompt: () => Promise<Record<string, unknown>>,
  notify: (method: string, params?: unknown) => Promise<void>,
  events: DesktopEvent[] = [],
  cancelTimeoutMs = 1_000,
): GrokRuntime {
  let nextId = 0;
  const runtime = new GrokRuntime((event) => events.push(event), {
    cancelTimeoutMs,
    createId: () => nextId++ === 0 ? "turn-cancel" : `permission-${nextId}`,
  } as ConstructorParameters<typeof GrokRuntime>[1]);
  attachFakeAgent(runtime, async (method) => {
    if (method === "session/new") return { sessionId: "session-cancel" };
    if (method === "session/prompt") return prompt();
    throw new Error(`Unexpected method: ${method}`);
  }, notify);
  return runtime;
}

function requestFakePermission(
  runtime: GrokRuntime,
  sessionId: string,
): Promise<Record<string, unknown>> {
  const internals = runtime as unknown as {
    handlePermissionRequest(
      request: {
        sessionId: string;
        toolCall: Record<string, unknown>;
        options: Array<Record<string, unknown>>;
      },
      signal: AbortSignal,
    ): Promise<Record<string, unknown>>;
  };
  return internals.handlePermissionRequest({
    sessionId,
    toolCall: { title: "Dangerous tool" },
    options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
  }, new AbortController().signal);
}

function emitFakeHistory(runtime: GrokRuntime, sessionId: string): void {
  emitFakeUpdate(runtime, sessionId, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "历史回复" },
  });
}

function emitFakeUpdate(
  runtime: GrokRuntime,
  sessionId: string,
  update: Record<string, unknown>,
): void {
  const internals = runtime as unknown as {
    handleSessionUpdate(notification: {
      sessionId: string;
      update: Record<string, unknown>;
    }): void;
  };
  internals.handleSessionUpdate({
    sessionId,
    update,
  });
}
