import { describe, expect, it } from "vitest";

import {
  parseAgentCapabilities,
  parseAvailableCommands,
  parseReportedMcpServerCount,
  parseSessionCapabilities,
} from "./acp-capabilities";

describe("ACP capability normalization", () => {
  it("projects exact standard and Grok capability flags into a bounded DTO", () => {
    const result = parseAgentCapabilities({
      loadSession: true,
      promptCapabilities: {
        image: false,
        audio: true,
        embeddedContext: true,
        _meta: { secret: "must not cross" },
      },
      mcpCapabilities: { http: true, sse: true, acp: false },
      sessionCapabilities: {
        list: {},
        delete: { _meta: { vendor: true } },
        additionalDirectories: {},
        fork: {},
        resume: {},
        close: {},
      },
      _meta: {
        "x.ai/fs_notify": true,
        "x.ai/hooks": {
          blockingEvents: ["pre_tool_use"],
          decisions: ["deny"],
          secret: "must not cross",
        },
        unknownCapability: { payload: "must not cross" },
      },
    });

    expect(result).toEqual({
      prompt: { image: false, audio: true, embeddedContext: true },
      mcp: { stdio: true, http: true, sse: true, acp: false },
      session: {
        load: true,
        list: true,
        delete: true,
        additionalDirectories: true,
        fork: true,
        resume: true,
        close: true,
      },
      extensions: { fsNotify: true, hooksCanDeny: true },
    });
    expect(JSON.stringify(result)).not.toContain("must not cross");
  });

  it("does not infer support from namespaces or non-standard truthy shapes", () => {
    expect(parseAgentCapabilities({
      loadSession: {},
      promptCapabilities: { image: 1, audio: "yes", embeddedContext: {} },
      mcpCapabilities: { http: {}, sse: 1, acp: "yes" },
      sessionCapabilities: {
        list: true,
        delete: [],
        additionalDirectories: false,
        fork: "yes",
        resume: null,
        close: 1,
      },
      _meta: {
        "x.ai/fs_notify": {},
        "x.ai/hooks": { blockingEvents: ["pre_tool_use"], decisions: ["allow"] },
      },
    })).toEqual({
      prompt: { image: false, audio: false, embeddedContext: false },
      mcp: { stdio: true, http: false, sse: false, acp: false },
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
    });
  });

  it("reduces Grok MCP runtime updates to a bounded non-sensitive count", () => {
    expect(parseReportedMcpServerCount({
      mcpServers: [
        { name: "local", command: "C:\\secret\\server.exe", headers: [{ value: "secret" }] },
        { name: "remote", url: "https://mcp.example.com/private" },
      ],
    })).toEqual({ count: 2, truncated: false });
    expect(parseReportedMcpServerCount({
      mcpServers: Array.from({ length: 300 }, () => ({})),
    })).toEqual({ count: 256, truncated: true });
    expect(parseReportedMcpServerCount({ mcpServers: [] })).toEqual({
      count: 0,
      truncated: false,
    });
    expect(parseReportedMcpServerCount({ mcpServers: "invalid" })).toBeNull();
    expect(parseReportedMcpServerCount({ mcpServers: [null, "invalid"] })).toBeNull();
    expect(parseReportedMcpServerCount({})).toBeNull();
  });

  it("preserves standard config options and model metadata", () => {
    const result = parseSessionCapabilities({
      configOptions: [{
        id: "reasoning",
        name: "Reasoning",
        type: "select",
        currentValue: "balanced",
        category: "thought_level",
        options: [{ value: "balanced", name: "Balanced" }],
        _meta: { secret: "must not cross" },
      }],
      models: {
        currentModelId: "grok-build",
        availableModels: [{ modelId: "grok-build", name: "Grok Build" }],
      },
    });

    expect(result.configOptions).toEqual([expect.objectContaining({
      id: "reasoning",
      currentValue: "balanced",
      readOnly: false,
    })]);
    expect(result.availableModels).toEqual([{ id: "grok-build", name: "Grok Build" }]);
    expect(result.currentModelId).toBe("grok-build");
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("projects only advertised reasoning-effort metadata for each model", () => {
    const result = parseSessionCapabilities({
      models: {
        currentModelId: "grok-build",
        availableModels: [{
          modelId: "grok-build",
          name: "Grok Build",
          _meta: {
            reasoningEffort: "high",
            reasoningEfforts: [
              { id: "low", value: "low", label: "Low", description: "Fast", default: false },
              { id: "high", value: "high", label: "High", description: "Thorough", default: true },
            ],
            secret: "must not cross",
          },
        }],
      },
    });

    expect(result.availableModels).toEqual([{
      id: "grok-build",
      name: "Grok Build",
      reasoningEffort: "high",
      reasoningEfforts: [
        { id: "low", name: "Low", description: "Fast", isDefault: false },
        { id: "high", name: "High", description: "Thorough", isDefault: true },
      ],
    }]);
    expect(JSON.stringify(result)).not.toContain("must not cross");
  });

  it("maps Grok session metadata options into a model selector", () => {
    const result = parseSessionCapabilities({
      models: {
        currentModelId: "grok-build",
        availableModels: [{ modelId: "grok-build", name: "Grok Build" }],
      },
      _meta: {
        "x.ai/sessionConfig": {
          options: [
            { id: "jbbtoken-grok-45", category: "model", label: "JBBToken Grok 4.5", selected: false },
            { id: "grok-build", category: "model", label: "Grok Build", selected: true },
          ],
        },
      },
    });

    expect(result.currentModelId).toBe("grok-build");
    expect(result.availableModels).toEqual([
      { id: "grok-build", name: "Grok Build" },
      { id: "jbbtoken-grok-45", name: "JBBToken Grok 4.5" },
    ]);
    expect(result.configOptions).toEqual([expect.objectContaining({
      id: "model",
      type: "select",
      category: "model",
      currentValue: "grok-build",
      readOnly: true,
    })]);
  });

  it("ignores non-model Grok session metadata options and their selected state", () => {
    const result = parseSessionCapabilities({
      _meta: {
        "x.ai/sessionConfig": {
          options: [
            {
              id: "balanced",
              category: "thought_level",
              label: "Balanced",
              selected: true,
            },
            {
              id: "grok-build",
              category: "model",
              label: "Grok Build",
              selected: false,
            },
          ],
        },
      },
    });

    expect(result.availableModels).toEqual([{ id: "grok-build", name: "Grok Build" }]);
    expect(result.currentModelId).toBe("grok-build");
    expect(result.configOptions).toEqual([expect.objectContaining({
      category: "model",
      currentValue: "grok-build",
      options: [{ value: "grok-build", name: "Grok Build" }],
    })]);
  });

  it("does not synthesize model capabilities from non-model extension options", () => {
    const result = parseSessionCapabilities({
      _meta: {
        "x.ai/sessionConfig": {
          options: [{
            id: "fast",
            category: "mode",
            label: "Fast",
            selected: true,
          }],
        },
      },
    });

    expect(result).toEqual({
      configOptions: [],
      availableModels: [],
      currentModelId: null,
    });
  });

  it("drops command metadata and normalizes optional input hints", () => {
    const result = parseAvailableCommands({
      availableCommands: [
        {
          name: "code-review",
          description: "Review the current changes",
          input: { hint: "optional scope" },
          _meta: { path: "C:\\secret\\skill.md", token: "secret" },
        },
        { name: "context", description: "Show context", input: null },
        { name: "code-review", description: "duplicate" },
        { name: "", description: "invalid" },
      ],
    });

    expect(result).toEqual([
      { name: "code-review", description: "Review the current changes", inputHint: "optional scope" },
      { name: "context", description: "Show context", inputHint: null },
    ]);
    expect(JSON.stringify(result)).not.toContain("skill.md");
  });

  it("normalizes a singular config option update", () => {
    const result = parseSessionCapabilities({
      sessionUpdate: "config_option_update",
      configOption: {
        id: "reasoning",
        name: "Reasoning",
        type: "select",
        currentValue: "balanced",
        options: [{ value: "balanced", name: "Balanced" }],
      },
    });

    expect(result.configOptions).toEqual([expect.objectContaining({
      id: "reasoning",
      readOnly: false,
      currentValue: "balanced",
    })]);
  });
});
