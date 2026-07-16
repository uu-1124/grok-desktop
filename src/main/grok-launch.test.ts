import { describe, expect, it } from "vitest";
import path from "node:path";

import {
  normalizeXaiApiBaseUrl,
  normalizeXaiApiKey,
} from "../shared/xai-connection";
import {
  buildGrokAgentLaunch,
  redactSensitiveText,
  redactSerializableSecrets,
} from "./grok-launch";

describe("xAI connection normalization", () => {
  it("normalizes HTTPS API base URLs", () => {
    expect(normalizeXaiApiBaseUrl("  https://API.EXAMPLE.COM:443/v1  ")).toBe(
      "https://api.example.com/v1",
    );
    expect(normalizeXaiApiBaseUrl(null)).toBeNull();
    expect(normalizeXaiApiBaseUrl(undefined)).toBeUndefined();
  });

  it.each([
    "http://localhost:8080/v1",
    "http://localhost.:8080/v1",
    "http://127.42.0.1:8080/v1",
    "http://[::1]:8080/v1",
  ])("allows HTTP only for loopback URL %s", (url) => {
    expect(normalizeXaiApiBaseUrl(url)).toBe(url);
  });

  it.each([
    "http://api.example.com/v1",
    "http://127.0.0.1.example.com/v1",
    "https://@api.example.com/v1",
    "https://user:password@api.example.com/v1",
    "https://api.example.com/v1?mode=test",
    "https://api.example.com/v1?",
    "https://api.example.com/v1#fragment",
    "https://api.example.com/v1#",
    "https://api.example.com/\0v1",
    "ftp://api.example.com/v1",
    "not a URL",
    "",
  ])("rejects unsafe API base URL %j", (url) => {
    expect(() => normalizeXaiApiBaseUrl(url)).toThrow(/xaiApiBaseUrl/u);
  });

  it("rejects oversized API base URLs", () => {
    const url = `https://api.example.com/${"a".repeat(2_048)}`;
    expect(() => normalizeXaiApiBaseUrl(url)).toThrow(/xaiApiBaseUrl/u);
  });

  it("normalizes the in-memory API key without exposing it in validation errors", () => {
    expect(normalizeXaiApiKey("  test-xai-key  ")).toBe("test-xai-key");

    const invalidKey = "test-secret\nvalue";
    let error: unknown;
    try {
      normalizeXaiApiKey(invalidKey);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).not.toContain(invalidKey);
  });
});

describe("Grok agent launch", () => {
  const explicitConnection = {
    xaiApiBaseUrl: "https://gateway.example.com/v1",
    xaiApiKey: "test-key",
  } as const;

  it("requires an explicit API base URL and API key as one connection pair", () => {
    expect(() => buildGrokAgentLaunch({
      modelId: null,
      permissionMode: "default",
      xaiApiBaseUrl: null,
      xaiApiKey: "test-key",
    })).toThrow(/base URL/u);
    expect(() => buildGrokAgentLaunch({
      modelId: null,
      permissionMode: "default",
      xaiApiBaseUrl: "https://gateway.example.com/v1",
    })).toThrow(/API key/u);
  });

  it("passes the base URL as an argument and the API key only through child env", () => {
    const parentEnv: NodeJS.ProcessEnv = {
      KEEP_ME: "present",
      XAI_API_KEY: "parent-test-key",
      GROK_CODE_XAI_API_KEY: "legacy-parent-test-key",
      GROK_MODELS_BASE_URL: "https://inherited.example.com/v1",
      GROK_MODELS_LIST_URL: "https://inherited.example.com/private-models",
      xai_api_key: "lowercase-parent-test-key",
      Grok_Code_Xai_Api_Key: "mixed-case-legacy-parent-test-key",
      grok_models_base_url: "https://lowercase-inherited.example.com/v1",
      Grok_Models_List_Url: "https://mixed-case-inherited.example.com/private-models",
      grok_xai_api_base_url: "https://lowercase-xai-inherited.example.com/v1",
    };
    const originalParentEnv = { ...parentEnv };
    const launch = buildGrokAgentLaunch(
      {
        modelId: "model-from-acp",
        permissionMode: "always_approve",
        xaiApiBaseUrl: "https://gateway.example.com/v1",
        xaiApiKey: "child-test-key",
      },
      parentEnv,
    );

    expect(launch.args).toEqual([
      "--permission-mode",
      "bypassPermissions",
      "agent",
      "--no-leader",
      "--model=model-from-acp",
      "--xai-api-base-url",
      "https://gateway.example.com/v1",
      "--always-approve",
      "stdio",
    ]);
    expect(launch.args).not.toContain("child-test-key");
    expect(launch.env).toMatchObject({
      KEEP_ME: "present",
      GROK_MODELS_BASE_URL: "https://gateway.example.com/v1",
      XAI_API_KEY: "child-test-key",
    });
    expect(launch.env.GROK_CODE_XAI_API_KEY).toBeUndefined();
    expect(launch.env.GROK_MODELS_LIST_URL).toBeUndefined();
    expect(Object.entries(launch.env)
      .filter(([name]) => [
        "XAI_API_KEY",
        "GROK_CODE_XAI_API_KEY",
        "GROK_MODELS_BASE_URL",
        "GROK_MODELS_LIST_URL",
        "GROK_XAI_API_BASE_URL",
      ].includes(name.toUpperCase()))
      .sort(([left], [right]) => left.localeCompare(right)))
      .toEqual([
        ["GROK_MODELS_BASE_URL", "https://gateway.example.com/v1"],
        ["XAI_API_KEY", "child-test-key"],
      ]);
    expect(parentEnv).toEqual(originalParentEnv);
  });

  it("isolates Grok configuration only when an explicit discovery home is supplied", () => {
    const isolatedHome = path.resolve("temporary-grok-discovery-home");
    const parentEnv: NodeJS.ProcessEnv = {
      GROK_HOME: path.resolve("user-grok-home"),
      Grok_Home: path.resolve("mixed-case-user-grok-home"),
    };

    const launch = buildGrokAgentLaunch({
      modelId: null,
      permissionMode: "default",
      grokHome: isolatedHome,
      ...explicitConnection,
    }, parentEnv);

    expect(Object.entries(launch.env).filter(
      ([name]) => name.toUpperCase() === "GROK_HOME",
    )).toEqual([["GROK_HOME", isolatedHome]]);
    expect(parentEnv).toHaveProperty("Grok_Home");
  });

  it("rejects a relative Grok discovery home", () => {
    expect(() => buildGrokAgentLaunch({
      modelId: null,
      permissionMode: "default",
      grokHome: "relative-grok-home",
      ...explicitConnection,
    })).toThrow(/grokHome/u);
  });

  it.each([
    "model\0override",
    "model\noverride",
    "model\roverride",
    "model\u001foverride",
    "model\u007foverride",
    "model\u0085override",
  ])("rejects model IDs containing control characters %#", (modelId) => {
    expect(() => buildGrokAgentLaunch({
      modelId,
      permissionMode: "default",
      ...explicitConnection,
    })).toThrow(/modelId/u);
  });

  it("binds a leading-dash model ID to the model option", () => {
    const launch = buildGrokAgentLaunch({
      modelId: "--always-approve",
      permissionMode: "default",
      ...explicitConnection,
    });

    expect(launch.args).toContain("--model=--always-approve");
    expect(launch.args).not.toContain("--always-approve");
  });

  it("passes a reasoning effort as a bound argument without allowing option injection", () => {
    const launch = buildGrokAgentLaunch({
      modelId: "grok-build",
      reasoningEffort: "--always-approve",
      permissionMode: "default",
      ...explicitConnection,
    });

    expect(launch.args).toContain("--reasoning-effort=--always-approve");
    expect(launch.args).not.toContain("--always-approve");
  });

  it.each([
    "high\0",
    "high\n",
    "high\r",
    "high\u001f",
  ])("rejects reasoning efforts containing control characters %#", (reasoningEffort) => {
    expect(() => buildGrokAgentLaunch({
      modelId: "grok-build",
      reasoningEffort,
      permissionMode: "default",
      ...explicitConnection,
    })).toThrow(/reasoningEffort/u);
  });

  it("rejects an ACP model ID that reflects the in-memory API key", () => {
    const apiKey = "reflection/key secret";
    let error: unknown;
    try {
      buildGrokAgentLaunch({
        modelId: `model-${apiKey}`,
        permissionMode: "default",
        xaiApiBaseUrl: explicitConnection.xaiApiBaseUrl,
        xaiApiKey: apiKey,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toMatch(/credential/u);
    expect((error as Error).message).not.toContain(apiKey);
  });

  it("rejects a URL-encoded API key reflected as an ACP reasoning effort", () => {
    const apiKey = "reflection/key secret";
    expect(() => buildGrokAgentLaunch({
      modelId: "safe-model",
      reasoningEffort: encodeURIComponent(apiKey).replace(
        /%[0-9A-F]{2}/gu,
        (escape) => escape.toLowerCase(),
      ),
      permissionMode: "default",
      xaiApiBaseUrl: explicitConnection.xaiApiBaseUrl,
      xaiApiKey: apiKey,
    })).toThrow(/credential/u);
  });

  it("uses Grok's native auto permission mode without enabling unrestricted approval", () => {
    const launch = buildGrokAgentLaunch({
      modelId: null,
      permissionMode: "auto",
      ...explicitConnection,
    });

    expect(launch.args).toEqual([
      "--permission-mode",
      "auto",
      "agent",
      "--no-leader",
      "--xai-api-base-url",
      "https://gateway.example.com/v1",
      "stdio",
    ]);
    expect(launch.args).not.toContain("--always-approve");
  });

  it("rejects unknown permission modes before building a child process argument vector", () => {
    expect(() => buildGrokAgentLaunch({
      modelId: null,
      permissionMode: "unknown" as "default",
      ...explicitConnection,
    })).toThrow(/permissionMode/u);
  });

  it("redacts an in-memory key before diagnostic text leaves the runtime", () => {
    const key = "diagnostic/test key";
    const diagnostic = redactSensitiveText(
      `request failed while using ${key} (${encodeURIComponent(key)})`,
      [key],
    );

    expect(diagnostic).toBe("request failed while using [REDACTED] ([REDACTED])");
    expect(diagnostic).not.toContain(key);
  });

  it("redacts JSON-escaped and credential-only diagnostic variants", () => {
    const authorization = 'Bearer abc"123';
    const credential = 'abc"123';
    const diagnostic = redactSensitiveText(
      `full=${authorization}; credential=${credential}; json=${JSON.stringify(authorization).slice(1, -1)}; encoded=${encodeURIComponent(authorization)}`,
      [authorization, credential],
    );

    expect(diagnostic).not.toContain("abc");
    expect(diagnostic.match(/\[REDACTED\]/gu)).toHaveLength(4);
  });

  it("redacts secrets recursively before protocol data crosses an event boundary", () => {
    const key = "event-test-key";
    const event = redactSerializableSecrets(
      {
        type: "session-update",
        update: {
          output: `unexpected ${key}`,
          nested: [{ [key]: key }],
        },
      },
      [key],
    );
    const serialized = JSON.stringify(event);

    expect(serialized).not.toContain(key);
    expect(serialized).toContain("[REDACTED]");
  });

  it("keeps protocol keys and enum values intact for short secrets", () => {
    const event = redactSerializableSecrets(
      {
        type: "runtime",
        snapshot: {
          phase: "ready",
          availableModels: [],
          message: "credential a rejected",
        },
        a: "a",
      },
      ["a"],
    ) as Record<string, unknown>;
    const snapshot = event.snapshot as Record<string, unknown>;

    expect(event.type).toBe("runtime");
    expect(snapshot.phase).toBe("ready");
    expect(snapshot).toHaveProperty("availableModels");
    expect(snapshot.message).toBe("credential [REDACTED] rejected");
    expect(event).toHaveProperty("[REDACTED]", "[REDACTED]");
  });

  it("preserves typed protocol structure when long secrets collide with control values", () => {
    const event = redactSerializableSecrets({
      type: "runtime",
      snapshot: {
        phase: "ready",
        message: "ready runtime session-update",
      },
      update: {
        sessionUpdate: "session-update",
        output: "runtime failed while ready",
      },
    }, ["ready", "runtime", "session-update"]);

    expect(event).toMatchObject({
      type: "runtime",
      snapshot: {
        phase: "ready",
        message: "[REDACTED] [REDACTED] [REDACTED]",
      },
      update: {
        sessionUpdate: "session-update",
        output: "[REDACTED] failed while [REDACTED]",
      },
    });
  });
});
