import { describe, expect, it } from "vitest";

import {
  constrainSessionCapabilitiesToModels,
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

  it("does not promote private Grok model aliases into the advertised catalog", () => {
    const result = parseSessionCapabilities({
      models: {
        currentModelId: "grok-4.5",
        availableModels: [
          { modelId: "grok-4.5", name: "grok-4.5" },
          { modelId: "grok-4.5-latest", name: "grok-4.5-latest" },
        ],
      },
      _meta: {
        "x.ai/sessionConfig": {
          options: [
            { id: "jbbtoken-grok-45", category: "model", label: "JBBToken Grok 4.5", selected: true },
            { id: "grok-build", category: "model", label: "grok-4.5", selected: false },
          ],
        },
      },
    });

    expect(result.currentModelId).toBe("grok-4.5");
    expect(result.availableModels).toEqual([
      { id: "grok-4.5", name: "grok-4.5" },
      { id: "grok-4.5-latest", name: "grok-4.5-latest" },
    ]);
    expect(result.configOptions).toEqual([expect.objectContaining({
      category: "model",
      currentValue: "jbbtoken-grok-45",
      readOnly: true,
    })]);
  });

  it("keeps legacy Grok aliases session-only when no advertised catalog exists", () => {
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
              id: "jbbtoken-grok-45",
              category: "model",
              label: "JBBToken Grok 4.5",
              selected: true,
            },
          ],
        },
      },
    });

    expect(result.availableModels).toEqual([]);
    expect(result.currentModelId).toBeNull();
    expect(result.configOptions).toEqual([expect.objectContaining({
      category: "model",
      currentValue: "jbbtoken-grok-45",
      readOnly: true,
    })]);
  });

  it("uses standard model config options as an authoritative catalog", () => {
    const result = parseSessionCapabilities({
      configOptions: [{
        id: "model",
        name: "Model",
        type: "select",
        currentValue: "grok-build",
        category: "model",
        options: [
          { value: "grok-build", name: "Grok Build" },
          { value: "grok-latest", name: "Grok Latest" },
        ],
      }],
      _meta: {
        "x.ai/sessionConfig": {
          options: [{
            id: "jbbtoken-grok-45",
            category: "model",
            label: "JBBToken Grok 4.5",
            selected: true,
          }],
        },
      },
    });

    expect(result.availableModels).toEqual([
      { id: "grok-build", name: "Grok Build" },
      { id: "grok-latest", name: "Grok Latest" },
    ]);
    expect(result.currentModelId).toBe("grok-build");
    expect(result.configOptions).toEqual([expect.objectContaining({
      id: "model",
      category: "model",
      currentValue: "grok-build",
    })]);
    expect(JSON.stringify(result)).not.toContain("jbbtoken-grok-45");
  });

  it("removes session model aliases outside an isolated discovery catalog", () => {
    const constrained = constrainSessionCapabilitiesToModels(
      parseSessionCapabilities({
        _meta: {
          modelState: {
            currentModelId: "jbbtoken-grok-45",
            availableModels: [
              { modelId: "grok-4.5", name: "grok-4.5" },
              { modelId: "jbbtoken-grok-45", name: "JBBToken Grok 4.5" },
            ],
          },
          "x.ai/sessionConfig": {
            options: [{
              id: "jbbtoken-grok-45",
              category: "model",
              label: "JBBToken Grok 4.5",
              selected: true,
            }],
          },
        },
      }),
      [{ id: "grok-4.5", name: "grok-4.5" }],
    );

    expect(constrained).toEqual({
      configOptions: [],
      availableModels: [{ id: "grok-4.5", name: "grok-4.5" }],
      currentModelId: null,
    });
  });

  it("uses isolated discovery metadata for matching session model ids", () => {
    const constrained = constrainSessionCapabilitiesToModels({
      configOptions: [{
        id: "model",
        name: "Model",
        type: "select",
        currentValue: "grok-4.5",
        readOnly: false,
        category: "model",
        options: [
          { value: "grok-4.5", name: "JBBToken Same-ID Override" },
          { value: "jbbtoken-grok-45", name: "JBBToken Grok 4.5" },
        ],
      }],
      availableModels: [
        { id: "grok-4.5", name: "JBBToken Same-ID Override" },
        { id: "jbbtoken-grok-45", name: "JBBToken Grok 4.5" },
      ],
      currentModelId: "grok-4.5",
    }, [{
      id: "grok-4.5",
      name: "grok-4.5",
      description: "Isolated API model",
    }]);

    expect(constrained).toEqual({
      configOptions: [expect.objectContaining({
        currentValue: "grok-4.5",
        options: [{
          value: "grok-4.5",
          name: "grok-4.5",
          description: "Isolated API model",
        }],
      })],
      availableModels: [{
        id: "grok-4.5",
        name: "grok-4.5",
        description: "Isolated API model",
      }],
      currentModelId: "grok-4.5",
    });
  });

  it("does not duplicate a standard model config id with a legacy selector", () => {
    const result = parseSessionCapabilities({
      configOptions: [{
        id: "model",
        name: "Model-like setting",
        type: "select",
        currentValue: "standard-value",
        options: [{ value: "standard-value", name: "Standard value" }],
      }],
      _meta: {
        "x.ai/sessionConfig": {
          options: [{
            id: "jbbtoken-grok-45",
            category: "model",
            label: "JBBToken Grok 4.5",
            selected: true,
          }],
        },
      },
    });

    expect(result.configOptions).toHaveLength(1);
    expect(result.configOptions[0]).toMatchObject({
      id: "model",
      currentValue: "standard-value",
      readOnly: false,
    });
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
