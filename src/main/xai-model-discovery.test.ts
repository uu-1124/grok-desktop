import { describe, expect, it, vi } from "vitest";

import { createEmptyRuntimeCapabilities } from "../shared/contracts";
import type { ConnectRequest, ModelInfo, RuntimeSnapshot } from "../shared/contracts";
import {
  connectWithXaiApiDiscovery,
  discoverXaiModels,
} from "./xai-model-discovery";

function snapshot(
  baseUrl: string,
  currentModelId = "model-a",
): RuntimeSnapshot {
  return {
    phase: "ready",
    permissionMode: "default",
    xaiApiBaseUrl: baseUrl,
    xaiApiKeyConfigured: true,
    mcpConfigured: false,
    reportedMcpServerCount: 0,
    reportedMcpServerCountTruncated: false,
    workspacePath: "D:\\project",
    executablePath: "D:\\grok.exe",
    grokVersion: "test",
    protocolVersion: 1,
    currentModelId,
    availableModels: [
      { id: "model-a", name: "Model A" },
      { id: "model-b", name: "Model B" },
    ],
    authMethods: [],
    capabilities: createEmptyRuntimeCapabilities(),
    sessionExecutions: [],
    message: null,
  };
}

function request(overrides: Partial<ConnectRequest> = {}): ConnectRequest {
  return {
    workspacePath: "D:\\project",
    executablePath: "D:\\grok.exe",
    permissionMode: "default",
    xaiApiBaseUrl: "https://gateway.example.com",
    xaiApiKey: "test-key",
    ...overrides,
  };
}

describe("xAI ACP endpoint and model discovery", () => {
  it("prefers /v1 for an arbitrary root URL and returns ACP-advertised models", async () => {
    const connect = vi.fn(async (attempt: ConnectRequest) =>
      snapshot(attempt.xaiApiBaseUrl));
    const disconnect = vi.fn(async () => undefined);

    const result = await discoverXaiModels(
      () => ({ connect, disconnect }),
      request(),
    );

    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect.mock.calls[0]?.[0]).toMatchObject({
      xaiApiBaseUrl: "https://gateway.example.com/v1",
      xaiApiKey: "test-key",
      modelId: undefined,
    });
    expect(result).toEqual({
      resolvedBaseUrl: "https://gateway.example.com/v1",
      currentModelId: "model-a",
      models: [
        { id: "model-a", name: "Model A" },
        { id: "model-b", name: "Model B" },
      ],
    });
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("falls back only to the exact same-origin URL when the first candidate fails", async () => {
    const connect = vi.fn(async (attempt: ConnectRequest) => {
      if (attempt.xaiApiBaseUrl.endsWith("/v1")) {
        throw new Error("simulated incompatible path");
      }
      return snapshot(attempt.xaiApiBaseUrl);
    });

    const result = await discoverXaiModels(
      () => ({ connect, disconnect: vi.fn(async () => undefined) }),
      request(),
    );

    expect(connect.mock.calls.map(([attempt]) => attempt.xaiApiBaseUrl)).toEqual([
      "https://gateway.example.com/v1",
      "https://gateway.example.com/",
    ]);
    expect(result.resolvedBaseUrl).toBe("https://gateway.example.com/");
  });

  it("validates a selected model with a disposable runtime before touching the target", async () => {
    const probeConnect = vi.fn(async (attempt: ConnectRequest) =>
      snapshot(attempt.xaiApiBaseUrl));
    const probeDisconnect = vi.fn(async () => undefined);
    const targetConnect = vi.fn(async (
      attempt: ConnectRequest,
      _advertisedModels: readonly ModelInfo[],
    ) =>
      snapshot(attempt.xaiApiBaseUrl, attempt.modelId ?? "model-a"));
    const target = {
      connectWithAdvertisedModels: targetConnect,
    };

    const result = await connectWithXaiApiDiscovery(
      () => ({ connect: probeConnect, disconnect: probeDisconnect }),
      target,
      request({ modelId: "model-b" }),
    );

    expect(probeConnect).toHaveBeenCalledOnce();
    expect(probeConnect.mock.calls[0]?.[0].modelId).toBeUndefined();
    expect(probeDisconnect).toHaveBeenCalledOnce();
    expect(targetConnect).toHaveBeenCalledOnce();
    expect(targetConnect.mock.calls[0]?.[0]).toMatchObject({
      modelId: "model-b",
      xaiApiBaseUrl: "https://gateway.example.com/v1",
    });
    expect(targetConnect.mock.calls[0]?.[1]).toEqual([
      { id: "model-a", name: "Model A" },
      { id: "model-b", name: "Model B" },
    ]);
    expect(result.currentModelId).toBe("model-b");
  });

  it("rejects a disappeared model without disturbing the target runtime", async () => {
    const probeConnect = vi.fn(async (attempt: ConnectRequest) =>
      snapshot(attempt.xaiApiBaseUrl));
    const targetConnect = vi.fn(async (attempt: ConnectRequest) =>
      snapshot(attempt.xaiApiBaseUrl));

    await expect(connectWithXaiApiDiscovery(
      () => ({ connect: probeConnect, disconnect: vi.fn(async () => undefined) }),
      { connectWithAdvertisedModels: targetConnect },
      request({ modelId: "invented-model" }),
    )).rejects.toThrow(/not advertised/u);
    expect(probeConnect).toHaveBeenCalledOnce();
    expect(targetConnect).not.toHaveBeenCalled();
  });

  it("uses the attempted same-origin candidate instead of a runtime-reported redirect", async () => {
    const result = await discoverXaiModels(
      () => ({
        connect: vi.fn(async () => snapshot("https://redirected.example.net/v1")),
        disconnect: vi.fn(async () => undefined),
      }),
      request(),
    );

    expect(result.resolvedBaseUrl).toBe("https://gateway.example.com/v1");
  });

  it("rejects ACP model metadata that reflects the in-memory key", async () => {
    const reflected = snapshot("https://gateway.example.com/v1", "model-test-key");
    reflected.availableModels = [{
      id: "safe-model",
      name: `reflected ${encodeURIComponent("test-key")}`,
    }];
    let error: unknown;
    try {
      await discoverXaiModels(
        () => ({
          connect: vi.fn(async () => reflected),
          disconnect: vi.fn(async () => undefined),
        }),
        request(),
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/credentials/u);
    expect((error as Error).message).not.toContain("test-key");
  });

  it("redacts the in-memory key when every candidate fails", async () => {
    const connect = vi.fn(async () => {
      throw new Error("request rejected for test-key");
    });

    await expect(discoverXaiModels(
      () => ({ connect, disconnect: vi.fn(async () => undefined) }),
      request(),
    )).rejects.not.toThrow(/test-key/u);
  });
});
