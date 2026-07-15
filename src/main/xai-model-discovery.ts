import type {
  ConnectRequest,
  DiscoverModelsResult,
  ModelInfo,
  RuntimeSnapshot,
} from "../shared/contracts.js";
import {
  normalizeRequiredXaiConnection,
  xaiApiBaseUrlCandidates,
} from "../shared/xai-connection.js";
import {
  containsSensitiveText,
  redactSensitiveText,
} from "./grok-launch.js";

const MAX_DISCOVERY_ERROR_LENGTH = 500;

export interface XaiDiscoveryRuntime {
  connect(request: ConnectRequest): Promise<RuntimeSnapshot>;
  disconnect(): Promise<void>;
}

export interface XaiTargetRuntime {
  connectWithAdvertisedModels(
    request: ConnectRequest,
    advertisedModels: readonly ModelInfo[],
  ): Promise<RuntimeSnapshot>;
}

export async function discoverXaiModels(
  createRuntime: () => XaiDiscoveryRuntime,
  request: ConnectRequest,
): Promise<DiscoverModelsResult> {
  const credentials = normalizeRequiredXaiConnection(
    request.xaiApiBaseUrl,
    request.xaiApiKey,
  );
  const runtime = createRuntime();
  let operationFailed = false;
  try {
    const discovered = await discoverWithRuntime(runtime, {
      ...request,
      modelId: undefined,
      reasoningEffort: undefined,
      mcpServers: undefined,
      allowStdioMcpExecution: undefined,
      ...credentials,
    });
    assertModelMetadataDoesNotContainCredential(
      discovered.snapshot,
      credentials.xaiApiKey,
    );
    return {
      resolvedBaseUrl: discovered.resolvedBaseUrl,
      currentModelId: discovered.snapshot.currentModelId,
      models: discovered.snapshot.availableModels.map(cloneModelInfo),
    };
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    try {
      await runtime.disconnect();
    } catch (error) {
      if (!operationFailed) throw error;
    }
  }
}

export async function connectWithXaiApiDiscovery(
  createDiscoveryRuntime: () => XaiDiscoveryRuntime,
  targetRuntime: XaiTargetRuntime,
  request: ConnectRequest,
): Promise<RuntimeSnapshot> {
  const {
    xaiApiBaseUrl: normalizedBaseUrl,
    xaiApiKey: normalizedApiKey,
  } = normalizeRequiredXaiConnection(request.xaiApiBaseUrl, request.xaiApiKey);
  const discovered = await discoverXaiModels(createDiscoveryRuntime, {
    ...request,
    xaiApiBaseUrl: normalizedBaseUrl,
    xaiApiKey: normalizedApiKey,
  });
  const requestedModelId = request.modelId?.trim() || undefined;
  if (requestedModelId && !discovered.models.some((model) => model.id === requestedModelId)) {
    throw new Error(
      "The requested model was not advertised by the Grok ACP connection for this API URL.",
    );
  }

  return targetRuntime.connectWithAdvertisedModels(
    {
      ...request,
      modelId: requestedModelId,
      reasoningEffort: requestedModelId ? request.reasoningEffort : undefined,
      xaiApiBaseUrl: discovered.resolvedBaseUrl,
      xaiApiKey: normalizedApiKey,
    },
    discovered.models,
  );
}

async function discoverWithRuntime(
  runtime: XaiDiscoveryRuntime,
  request: ConnectRequest,
): Promise<{ snapshot: RuntimeSnapshot; resolvedBaseUrl: string }> {
  const {
    xaiApiBaseUrl: normalizedBaseUrl,
    xaiApiKey: normalizedApiKey,
  } = normalizeRequiredXaiConnection(request.xaiApiBaseUrl, request.xaiApiKey);
  const failures: unknown[] = [];
  for (const candidate of xaiApiBaseUrlCandidates(normalizedBaseUrl)) {
    try {
      const snapshot = await runtime.connect({
        ...request,
        modelId: undefined,
        reasoningEffort: undefined,
        xaiApiBaseUrl: candidate,
        xaiApiKey: normalizedApiKey,
      });
      return { snapshot, resolvedBaseUrl: candidate };
    } catch (error) {
      failures.push(error);
    }
  }

  throw discoveryFailure(failures, normalizedApiKey);
}

function discoveryFailure(failures: readonly unknown[], apiKey: string): Error {
  const first = failures[0];
  const raw = first instanceof Error
    ? first.message
    : typeof first === "string"
      ? first
      : "Grok did not accept any same-origin API path candidate.";
  const detail = redactSensitiveText(raw, [apiKey])
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_DISCOVERY_ERROR_LENGTH);
  return new Error(
    `Unable to resolve the supplied API base URL through Grok ACP after ${failures.length} same-origin attempt${failures.length === 1 ? "" : "s"}. ${detail}`,
  );
}

function cloneModelInfo(model: ModelInfo): ModelInfo {
  return {
    ...model,
    ...(model.reasoningEfforts
      ? { reasoningEfforts: model.reasoningEfforts.map((effort) => ({ ...effort })) }
      : {}),
  };
}

function assertModelMetadataDoesNotContainCredential(
  snapshot: RuntimeSnapshot,
  apiKey: string,
): void {
  const values = snapshot.availableModels.flatMap((model) => [
    model.id,
    model.name,
    model.description,
    model.reasoningEffort,
    ...(model.reasoningEfforts ?? []).flatMap((effort) => [
      effort.id,
      effort.name,
      effort.description,
    ]),
  ]);
  if (snapshot.currentModelId) values.push(snapshot.currentModelId);
  if (values.some((value) => typeof value === "string" && containsSensitiveText(value, [apiKey]))) {
    throw new Error("Grok ACP returned model metadata containing API credentials.");
  }
}
