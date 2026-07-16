import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
const DISCOVERY_HOME_PREFIX = "grok-desktop-model-discovery-";

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

export type XaiDiscoveryRuntimeFactory = (grokHome: string) => XaiDiscoveryRuntime;

export async function discoverXaiModels(
  createRuntime: XaiDiscoveryRuntimeFactory,
  request: ConnectRequest,
): Promise<DiscoverModelsResult> {
  const credentials = normalizeRequiredXaiConnection(
    request.xaiApiBaseUrl,
    request.xaiApiKey,
  );
  const discovered = await discoverWithRuntime(createRuntime, {
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
}

export async function connectWithXaiApiDiscovery(
  createDiscoveryRuntime: XaiDiscoveryRuntimeFactory,
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
  const explicitModelId = request.modelId?.trim() || undefined;
  if (explicitModelId && !discovered.models.some((model) => model.id === explicitModelId)) {
    throw new Error(
      "The requested model was not advertised by the Grok ACP connection for this API URL.",
    );
  }
  const requestedModelId = explicitModelId ?? (
    discovered.currentModelId && discovered.models.some(
      (model) => model.id === discovered.currentModelId,
    )
      ? discovered.currentModelId
      : discovered.models[0]?.id
  );
  if (!requestedModelId) {
    throw new Error("Grok ACP discovery did not return an available model.");
  }

  return targetRuntime.connectWithAdvertisedModels(
    {
      ...request,
      modelId: requestedModelId,
      reasoningEffort: explicitModelId ? request.reasoningEffort : undefined,
      xaiApiBaseUrl: discovered.resolvedBaseUrl,
      xaiApiKey: normalizedApiKey,
    },
    discovered.models,
  );
}

async function removeTemporaryGrokHome(temporaryRoot: string, grokHome: string): Promise<void> {
  const relative = path.relative(temporaryRoot, grokHome);
  if (
    !relative ||
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    !path.basename(grokHome).startsWith(DISCOVERY_HOME_PREFIX)
  ) {
    throw new Error("Refusing to remove an invalid temporary Grok discovery directory.");
  }
  await rm(grokHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

async function discoverWithRuntime(
  createRuntime: XaiDiscoveryRuntimeFactory,
  request: ConnectRequest,
): Promise<{ snapshot: RuntimeSnapshot; resolvedBaseUrl: string }> {
  const {
    xaiApiBaseUrl: normalizedBaseUrl,
    xaiApiKey: normalizedApiKey,
  } = normalizeRequiredXaiConnection(request.xaiApiBaseUrl, request.xaiApiKey);
  const failures: unknown[] = [];
  for (const candidate of xaiApiBaseUrlCandidates(normalizedBaseUrl)) {
    try {
      const snapshot = await withIsolatedDiscoveryRuntime(
        createRuntime,
        (runtime) => runtime.connect({
          ...request,
          modelId: undefined,
          reasoningEffort: undefined,
          xaiApiBaseUrl: candidate,
          xaiApiKey: normalizedApiKey,
        }),
      );
      return { snapshot, resolvedBaseUrl: candidate };
    } catch (error) {
      failures.push(error);
    }
  }

  throw discoveryFailure(failures, normalizedApiKey);
}

async function withIsolatedDiscoveryRuntime<T>(
  createRuntime: XaiDiscoveryRuntimeFactory,
  operation: (runtime: XaiDiscoveryRuntime) => Promise<T>,
): Promise<T> {
  const temporaryRoot = await realpath(os.tmpdir());
  const grokHome = await mkdtemp(path.join(temporaryRoot, DISCOVERY_HOME_PREFIX));
  let runtime: XaiDiscoveryRuntime | null = null;
  let operationFailed = false;
  try {
    runtime = createRuntime(grokHome);
    return await operation(runtime);
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    let cleanupError: unknown = null;
    try {
      await runtime?.disconnect();
    } catch (error) {
      cleanupError = error;
    }
    try {
      await removeTemporaryGrokHome(temporaryRoot, grokHome);
    } catch (error) {
      cleanupError ??= error;
    }
    if (cleanupError) {
      if (operationFailed) {
        throw new Error("Grok model discovery failed and its isolated runtime could not be cleaned up.");
      }
      throw cleanupError;
    }
  }
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
