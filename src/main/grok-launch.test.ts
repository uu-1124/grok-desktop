import { describe, expect, it } from "vitest";

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
  it("passes the base URL as an argument and the API key only through child env", () => {
    const parentEnv: NodeJS.ProcessEnv = {
      KEEP_ME: "present",
      XAI_API_KEY: "parent-test-key",
      GROK_CODE_XAI_API_KEY: "legacy-parent-test-key",
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
      XAI_API_KEY: "child-test-key",
    });
    expect(launch.env.GROK_CODE_XAI_API_KEY).toBeUndefined();
    expect(parentEnv).toEqual(originalParentEnv);
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
      xaiApiBaseUrl: null,
    })).toThrow(/modelId/u);
  });

  it("binds a leading-dash model ID to the model option", () => {
    const launch = buildGrokAgentLaunch({
      modelId: "--always-approve",
      permissionMode: "default",
      xaiApiBaseUrl: null,
    });

    expect(launch.args).toContain("--model=--always-approve");
    expect(launch.args).not.toContain("--always-approve");
  });

  it("passes a reasoning effort as a bound argument without allowing option injection", () => {
    const launch = buildGrokAgentLaunch({
      modelId: "grok-build",
      reasoningEffort: "--always-approve",
      permissionMode: "default",
      xaiApiBaseUrl: null,
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
      xaiApiBaseUrl: null,
    })).toThrow(/reasoningEffort/u);
  });

  it("preserves Grok's inherited credential behavior for the default endpoint", () => {
    const launch = buildGrokAgentLaunch(
      {
        modelId: null,
        permissionMode: "default",
        xaiApiBaseUrl: null,
      },
      {
        KEEP_ME: "present",
        XAI_API_KEY: "inherited-test-key",
        GROK_CODE_XAI_API_KEY: "legacy-inherited-test-key",
      },
    );

    expect(launch.args).toEqual([
      "--permission-mode",
      "default",
      "agent",
      "--no-leader",
      "stdio",
    ]);
    expect(launch.env).toMatchObject({
      KEEP_ME: "present",
      XAI_API_KEY: "inherited-test-key",
      GROK_CODE_XAI_API_KEY: "legacy-inherited-test-key",
    });
  });

  it("uses Grok's native auto permission mode without enabling unrestricted approval", () => {
    const launch = buildGrokAgentLaunch({
      modelId: null,
      permissionMode: "auto",
      xaiApiBaseUrl: null,
    });

    expect(launch.args).toEqual([
      "--permission-mode",
      "auto",
      "agent",
      "--no-leader",
      "stdio",
    ]);
    expect(launch.args).not.toContain("--always-approve");
  });

  it("rejects unknown permission modes before building a child process argument vector", () => {
    expect(() => buildGrokAgentLaunch({
      modelId: null,
      permissionMode: "unknown" as "default",
      xaiApiBaseUrl: null,
    })).toThrow(/permissionMode/u);
  });

  it.each([
    "https://gateway.example.com/v1",
    "http://localhost:8080/v1",
  ])(
    "strips inherited xAI credentials for custom endpoint %s without an explicit key",
    (xaiApiBaseUrl) => {
      const parentEnv: NodeJS.ProcessEnv = {
        KEEP_ME: "present",
        XAI_API_KEY: "inherited-test-key",
        GROK_CODE_XAI_API_KEY: "legacy-inherited-test-key",
      };
      const originalParentEnv = { ...parentEnv };
      const launch = buildGrokAgentLaunch(
        {
          modelId: null,
          permissionMode: "default",
          xaiApiBaseUrl,
        },
        parentEnv,
      );

      expect(launch.args).toContain(xaiApiBaseUrl);
      expect(launch.env.KEEP_ME).toBe("present");
      expect(launch.env.XAI_API_KEY).toBeUndefined();
      expect(launch.env.GROK_CODE_XAI_API_KEY).toBeUndefined();
      expect(parentEnv).toEqual(originalParentEnv);
    },
  );

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
