import type {
  AvailableCommand,
  ModelInfo,
  ReasoningEffortInfo,
  RuntimeCapabilities,
  SessionConfigOption,
  SessionConfigValue,
} from "../shared/contracts.js";

const MAX_ID_LENGTH = 1_024;
const MAX_TEXT_LENGTH = 8_192;
const MAX_OPTIONS = 256;
const MAX_REPORTED_MCP_SERVERS = 256;
const MAX_REPORTED_MCP_SERVER_CANDIDATES = 1_024;

export type SafeAvailableCommand = AvailableCommand;

export interface ParsedSessionCapabilities {
  configOptions: SessionConfigOption[];
  availableModels: ModelInfo[];
  currentModelId: string | null;
}

export function parseAgentCapabilities(value: unknown): RuntimeCapabilities {
  const capabilities = asRecord(value);
  const prompt = asRecord(capabilities?.promptCapabilities);
  const mcp = asRecord(capabilities?.mcpCapabilities);
  const session = asRecord(capabilities?.sessionCapabilities);
  const metadata = asRecord(capabilities?._meta);
  const hooks = asRecord(metadata?.["x.ai/hooks"]);

  return {
    prompt: {
      image: prompt?.image === true,
      audio: prompt?.audio === true,
      embeddedContext: prompt?.embeddedContext === true,
    },
    mcp: {
      // ACP v1 requires every agent to support stdio MCP. The parser is only
      // called after a successful initialize response with a capabilities map.
      stdio: capabilities !== null,
      http: mcp?.http === true,
      sse: mcp?.sse === true,
      acp: mcp?.acp === true,
    },
    session: {
      load: capabilities?.loadSession === true,
      list: isCapabilityMarker(session?.list),
      delete: isCapabilityMarker(session?.delete),
      additionalDirectories: isCapabilityMarker(session?.additionalDirectories),
      fork: isCapabilityMarker(session?.fork),
      resume: isCapabilityMarker(session?.resume),
      close: isCapabilityMarker(session?.close),
    },
    extensions: {
      fsNotify: metadata?.["x.ai/fs_notify"] === true,
      hooksCanDeny:
        hasStringEntry(hooks?.blockingEvents, "pre_tool_use") &&
        hasStringEntry(hooks?.decisions, "deny"),
    },
  };
}

export interface ReportedMcpServerSummary {
  count: number;
  truncated: boolean;
}

export function parseReportedMcpServerCount(value: unknown): ReportedMcpServerSummary | null {
  const notification = asRecord(value);
  if (!Array.isArray(notification?.mcpServers)) {
    return null;
  }

  let count = 0;
  let inspected = 0;
  for (const server of notification.mcpServers) {
    if (
      inspected >= MAX_REPORTED_MCP_SERVER_CANDIDATES ||
      count >= MAX_REPORTED_MCP_SERVERS
    ) {
      break;
    }
    inspected += 1;
    if (asRecord(server) === null) {
      return null;
    }
    count += 1;
  }

  return {
    count,
    truncated: inspected < notification.mcpServers.length,
  };
}

/**
 * Normalizes standard ACP session data and Grok's x.ai session metadata into
 * renderer-safe DTOs. Unknown metadata is deliberately discarded.
 */
export function parseSessionCapabilities(value: unknown): ParsedSessionCapabilities {
  const record = asRecord(value);
  if (!record) {
    return { configOptions: [], availableModels: [], currentModelId: null };
  }

  const standardOptions = parseStandardConfigOptions(
    record.configOptions ??
      (record.configOption !== undefined
        ? [record.configOption]
        : isConfigOptionRecord(record)
          ? [record]
          : undefined),
  );
  const metadata = asRecord(record._meta);
  const xaiSessionConfig = asRecord(metadata?.["x.ai/sessionConfig"]);
  const extensionOptions = parseExtensionModelOptions(xaiSessionConfig?.options);
  const models = parseModels(
    record.models ??
      firstDefined(
        asRecord(metadata?.modelState),
        asRecord(record.modelState),
      ),
  );

  const extensionCurrentModelId = selectedExtensionModelId(xaiSessionConfig);
  const initialModelId =
    models.currentModelId ?? extensionCurrentModelId ?? extensionOptions[0]?.id ?? null;
  const configOptions = standardOptions.length > 0
    ? standardOptions
      : extensionOptions.length > 0
      ? [createModelConfigOption(extensionOptions, initialModelId)]
      : [];
  const optionModels = extractModelsFromConfigOptions(configOptions);
  const availableModels = deduplicateModels([
    ...models.availableModels,
    ...optionModels,
    ...extensionOptions,
  ]);
  const currentModelId = models.currentModelId ?? currentModelFromConfig(configOptions) ?? initialModelId;

  return {
    configOptions,
    availableModels,
    currentModelId,
  };
}

/**
 * Keeps only the stable command fields that can be rendered safely. In
 * particular, Grok's `_meta.path` and other implementation details never
 * cross the main/renderer boundary.
 */
export function parseAvailableCommands(value: unknown): SafeAvailableCommand[] {
  const record = asRecord(value);
  const candidates = Array.isArray(record?.availableCommands)
    ? record.availableCommands
    : Array.isArray(value)
      ? value
      : [];

  const commands: SafeAvailableCommand[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates.slice(0, MAX_OPTIONS)) {
    const command = asRecord(candidate);
    const name = normalizeText(command?.name, MAX_ID_LENGTH);
    if (!name || seen.has(name)) {
      continue;
    }
    const description = normalizeText(command?.description, MAX_TEXT_LENGTH) ?? "";
    const input = asRecord(command?.input);
    const inputHint = normalizeText(input?.hint, MAX_TEXT_LENGTH);
    commands.push({ name, description, ...(inputHint ? { inputHint } : { inputHint: null }) });
    seen.add(name);
  }
  return commands;
}

function parseStandardConfigOptions(value: unknown): SessionConfigOption[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .slice(0, MAX_OPTIONS)
    .flatMap((candidate): SessionConfigOption[] => {
      const option = asRecord(candidate);
      const id = normalizeText(option?.id, MAX_ID_LENGTH);
      const name = normalizeText(option?.name, MAX_TEXT_LENGTH);
      const type = option?.type;
      if (!id || !name || (type !== "select" && type !== "boolean")) {
        return [];
      }

      if (type === "boolean" && typeof option?.currentValue === "boolean") {
        return [{
          id,
          name,
          type,
          currentValue: option.currentValue,
          readOnly: false,
          ...optionalText(option?.description, "description"),
          ...optionalText(option?.category, "category"),
        }];
      }

      if (type !== "select" || typeof option?.currentValue !== "string") {
        return [];
      }
      const options = parseSelectOptions(option.options);
      if (options.length === 0) {
        return [];
      }
      return [{
        id,
        name,
        type,
        currentValue: option.currentValue,
        readOnly: false,
        options,
        ...optionalText(option?.description, "description"),
        ...optionalText(option?.category, "category"),
      }];
    });
}

function isConfigOptionRecord(value: Record<string, unknown>): boolean {
  return typeof value.id === "string" &&
    (value.type === "select" || value.type === "boolean");
}

function parseExtensionModelOptions(value: unknown): ModelInfo[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.slice(0, MAX_OPTIONS).flatMap((candidate) => {
    const option = asRecord(candidate);
    if (option?.category !== "model") {
      return [];
    }
    const id = normalizeText(option?.id ?? option?.modelId ?? option?.value, MAX_ID_LENGTH);
    if (!id) {
      return [];
    }
    const name = normalizeText(option?.label ?? option?.name ?? option?.title, MAX_TEXT_LENGTH) ?? id;
    const description = normalizeText(option?.description, MAX_TEXT_LENGTH);
    return [{ id, name, ...(description ? { description } : {}) }];
  });
}

function parseModels(value: unknown): {
  currentModelId: string | null;
  availableModels: ModelInfo[];
} {
  const record = asRecord(value);
  if (!record) {
    return { currentModelId: null, availableModels: [] };
  }
  const currentModelId = normalizeText(
    record.currentModelId ?? record.current_model_id,
    MAX_ID_LENGTH,
  );
  const candidates = Array.isArray(record.availableModels)
    ? record.availableModels
    : Array.isArray(record.models)
      ? record.models
      : [];
  const availableModels = candidates.slice(0, MAX_OPTIONS).flatMap((candidate) => {
    const model = asRecord(candidate);
    const id = normalizeText(model?.modelId ?? model?.id ?? model?.value, MAX_ID_LENGTH);
    if (!id) {
      return [];
    }
    const name = normalizeText(model?.name ?? model?.label ?? model?.title, MAX_TEXT_LENGTH) ?? id;
    const description = normalizeText(model?.description, MAX_TEXT_LENGTH);
    const metadata = asRecord(model?._meta);
    const reasoningEffort = normalizeText(
      metadata?.reasoningEffort ?? model?.reasoningEffort,
      MAX_ID_LENGTH,
    );
    const reasoningEfforts = parseReasoningEfforts(
      metadata?.reasoningEfforts ?? model?.reasoningEfforts,
    );
    return [{
      id,
      name,
      ...(description ? { description } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(reasoningEfforts.length > 0 ? { reasoningEfforts } : {}),
    }];
  });
  return { currentModelId, availableModels: deduplicateModels(availableModels) };
}

function parseReasoningEfforts(value: unknown): ReasoningEffortInfo[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return deduplicateById(value.slice(0, MAX_OPTIONS).flatMap((candidate): ReasoningEffortInfo[] => {
    const effort = asRecord(candidate);
    const id = normalizeText(effort?.id ?? effort?.value, MAX_ID_LENGTH);
    if (!id) {
      return [];
    }
    const name = normalizeText(effort?.label ?? effort?.name ?? effort?.title, MAX_TEXT_LENGTH) ?? id;
    const description = normalizeText(effort?.description, MAX_TEXT_LENGTH);
    return [{
      id,
      name,
      ...(description ? { description } : {}),
      isDefault: effort?.default === true,
    }];
  }));
}

function createModelConfigOption(
  models: readonly ModelInfo[],
  currentModelId: string | null,
): SessionConfigOption {
  return {
    id: "model",
    name: "Model",
    type: "select",
    currentValue: currentModelId ?? models[0]?.id ?? "",
    readOnly: true,
    category: "model",
    options: models.map((model) => ({
      value: model.id,
      name: model.name,
      ...(model.description ? { description: model.description } : {}),
    })),
  };
}

function parseSelectOptions(value: unknown): SessionConfigValue[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const options: SessionConfigValue[] = [];
  for (const candidate of value.slice(0, MAX_OPTIONS)) {
    const group = asRecord(candidate);
    if (typeof group?.group === "string" && Array.isArray(group.options)) {
      options.push(...parseSelectOptions(group.options));
      continue;
    }
    const option = group;
    const optionValue = normalizeText(option?.value, MAX_ID_LENGTH);
    if (!optionValue) {
      continue;
    }
    const name = normalizeText(option?.name ?? option?.label, MAX_TEXT_LENGTH) ?? optionValue;
    const description = normalizeText(option?.description, MAX_TEXT_LENGTH);
    options.push({ value: optionValue, name, ...(description ? { description } : {}) });
  }
  return deduplicateByValue(options);
}

function extractModelsFromConfigOptions(options: readonly SessionConfigOption[]): ModelInfo[] {
  return options.flatMap((option) => {
    if (option.type !== "select" || option.category !== "model") {
      return [];
    }
    return parseSelectOptions(option.options).map((value) => ({
      id: value.value,
      name: value.name,
      ...(value.description ? { description: value.description } : {}),
    }));
  });
}

function currentModelFromConfig(options: readonly SessionConfigOption[]): string | null {
  const option = options.find((candidate) => candidate.type === "select" && candidate.category === "model");
  return option && option.type === "select" && typeof option.currentValue === "string"
    ? option.currentValue
    : null;
}

function selectedExtensionModelId(config: Record<string, unknown> | null): string | null {
  const options = Array.isArray(config?.options) ? config.options : [];
  for (const candidate of options.slice(0, MAX_OPTIONS)) {
    const option = asRecord(candidate);
    if (option?.category === "model" && option.selected === true) {
      return normalizeText(option.id ?? option.modelId ?? option.value, MAX_ID_LENGTH);
    }
  }
  return null;
}

function deduplicateModels(models: readonly ModelInfo[]): ModelInfo[] {
  return deduplicateById(models);
}

function deduplicateById<T extends { id: string }>(values: readonly T[]): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (seen.has(value.id)) {
      return false;
    }
    seen.add(value.id);
    return true;
  });
}

function deduplicateByValue<T extends { value: string }>(values: readonly T[]): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (seen.has(value.value)) {
      return false;
    }
    seen.add(value.value);
    return true;
  });
}

function optionalText(value: unknown, key: "description" | "category"): Record<string, string> {
  const normalized = normalizeText(value, MAX_TEXT_LENGTH);
  return normalized ? { [key]: normalized } : {};
}

function normalizeText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maximum) : null;
}

function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isCapabilityMarker(value: unknown): boolean {
  return asRecord(value) !== null;
}

function hasStringEntry(value: unknown, expected: string): boolean {
  return Array.isArray(value) && value.slice(0, MAX_OPTIONS).some((entry) => entry === expected);
}
