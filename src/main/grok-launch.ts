import {
  normalizeXaiApiBaseUrl,
  normalizeXaiApiKey,
} from "../shared/xai-connection.js";

const MAX_MODEL_ID_LENGTH = 1_024;
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;
const SHORT_SENSITIVE_VALUE_LENGTH = 4;
const PROTOCOL_PROPERTY_NAMES = new Set([
  "additionalDirectories",
  "args",
  "authMethods",
  "availableCommands",
  "availableModels",
  "availableModes",
  "capabilities",
  "category",
  "configId",
  "configOptions",
  "content",
  "cost",
  "createdAt",
  "currentModeId",
  "currentModelId",
  "currentValue",
  "cwd",
  "data",
  "description",
  "detail",
  "entries",
  "error",
  "event",
  "executablePath",
  "expiresAt",
  "extensions",
  "finishedAt",
  "id",
  "inputHint",
  "kind",
  "label",
  "level",
  "line",
  "loaded",
  "locations",
  "mcp",
  "mcpConfigured",
  "message",
  "messageId",
  "mimeType",
  "name",
  "optionId",
  "options",
  "outcome",
  "output",
  "path",
  "payload",
  "pendingPermissionCount",
  "permissionMode",
  "phase",
  "planId",
  "priority",
  "prompt",
  "protocolVersion",
  "rawInput",
  "rawOutput",
  "readOnly",
  "reasoningEffort",
  "reasoningEfforts",
  "receivedAt",
  "relativePath",
  "reportedMcpServerCount",
  "reportedMcpServerCountTruncated",
  "requestId",
  "resource",
  "session",
  "sessionExecutions",
  "sessionId",
  "sessionUpdate",
  "size",
  "snapshot",
  "startedAt",
  "status",
  "stopReason",
  "text",
  "thoughtTokens",
  "title",
  "toolCall",
  "toolCallId",
  "totalTokens",
  "turnId",
  "type",
  "update",
  "updatedAt",
  "uri",
  "usage",
  "used",
  "value",
  "workspacePath",
]);
const PROTOCOL_CONTROL_VALUE_NAMES = new Set([
  "category",
  "configId",
  "createdAt",
  "currentModeId",
  "currentModelId",
  "currentValue",
  "cwd",
  "executablePath",
  "expiresAt",
  "finishedAt",
  "id",
  "kind",
  "level",
  "messageId",
  "mimeType",
  "name",
  "optionId",
  "outcome",
  "path",
  "permissionMode",
  "phase",
  "planId",
  "priority",
  "reasoningEffort",
  "receivedAt",
  "relativePath",
  "requestId",
  "sessionId",
  "sessionUpdate",
  "startedAt",
  "status",
  "stopReason",
  "toolCallId",
  "turnId",
  "type",
  "updatedAt",
  "uri",
  "value",
  "workspacePath",
]);

export interface GrokAgentLaunchOptions {
  modelId: string | null;
  reasoningEffort?: string | null;
  alwaysApprove: boolean;
  xaiApiBaseUrl: string | null;
  xaiApiKey?: string;
}

export interface GrokAgentLaunch {
  args: string[];
  env: NodeJS.ProcessEnv;
}

export function buildGrokAgentLaunch(
  options: GrokAgentLaunchOptions,
  parentEnv: Readonly<NodeJS.ProcessEnv> = process.env,
): GrokAgentLaunch {
  const xaiApiBaseUrl = normalizeXaiApiBaseUrl(options.xaiApiBaseUrl) ?? null;
  const xaiApiKey = normalizeXaiApiKey(options.xaiApiKey);
  const modelId = normalizeModelId(options.modelId);
  const reasoningEffort = normalizeReasoningEffort(options.reasoningEffort ?? null);
  const args = [
    "--permission-mode",
    options.alwaysApprove ? "bypassPermissions" : "default",
    "agent",
    // The desktop connection owns its endpoint, credentials, model, and
    // permission policy. A shared Grok leader could have been started with a
    // different configuration, so it must not silently become this session's
    // backend.
    "--no-leader",
  ];

  if (modelId) {
    args.push(`--model=${modelId}`);
  }
  if (reasoningEffort) {
    args.push(`--reasoning-effort=${reasoningEffort}`);
  }
  if (xaiApiBaseUrl) {
    args.push("--xai-api-base-url", xaiApiBaseUrl);
  }
  if (options.alwaysApprove) {
    args.push("--always-approve");
  }
  args.push("stdio");

  const env: NodeJS.ProcessEnv = { ...parentEnv };
  if (xaiApiKey !== undefined) {
    // Grok accepts this legacy alias as a fallback. Remove it when the user
    // explicitly supplies a key so an inherited value cannot win through an
    // implementation-specific precedence rule.
    delete env.GROK_CODE_XAI_API_KEY;
    env.XAI_API_KEY = xaiApiKey;
  } else if (xaiApiBaseUrl !== null) {
    // A custom endpoint must not receive credentials inherited from the
    // desktop process unless the user explicitly supplied a key for it.
    delete env.XAI_API_KEY;
    delete env.GROK_CODE_XAI_API_KEY;
  }
  return { args, env };
}

function normalizeModelId(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > MAX_MODEL_ID_LENGTH ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    throw new TypeError(
      `modelId must be a non-empty string of at most ${MAX_MODEL_ID_LENGTH} characters without control characters.`,
    );
  }
  return value.trim();
}

function normalizeReasoningEffort(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > MAX_MODEL_ID_LENGTH ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    throw new TypeError(
      `reasoningEffort must be a non-empty string of at most ${MAX_MODEL_ID_LENGTH} characters without control characters.`,
    );
  }
  return value.trim();
}

export function redactSensitiveText(
  value: string,
  sensitiveValues: readonly string[],
): string {
  let redacted = value;
  for (const sensitiveValue of sensitiveValues) {
    for (const variant of sensitiveTextVariants(sensitiveValue)) {
      redacted = replaceSensitiveVariant(redacted, variant, sensitiveValue.length);
    }
  }
  return redacted;
}

function sensitiveTextVariants(value: string): string[] {
  if (!value) return [];
  const variants = new Set([value]);
  const jsonEscaped = JSON.stringify(value).slice(1, -1);
  if (jsonEscaped) variants.add(jsonEscaped);
  try {
    variants.add(encodeURIComponent(value));
  } catch {
    // Raw and JSON-escaped forms still protect malformed Unicode values.
  }
  return [...variants].filter(Boolean).sort((left, right) => right.length - left.length);
}

function replaceSensitiveVariant(
  value: string,
  variant: string,
  originalLength: number,
): string {
  if (originalLength >= SHORT_SENSITIVE_VALUE_LENGTH) {
    return value.split(variant).join("[REDACTED]");
  }
  const escaped = variant.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return value.replace(
    new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "gu"),
    "[REDACTED]",
  );
}

export function redactSerializableSecrets<T>(
  value: T,
  sensitiveValues: readonly string[],
): T {
  if (sensitiveValues.length === 0) {
    return value;
  }
  return redactSerializableValue(
    value,
    sensitiveValues,
    new WeakMap<object, unknown>(),
  );
}

function redactSerializableValue<T>(
  value: T,
  sensitiveValues: readonly string[],
  seen: WeakMap<object, unknown>,
  propertyName?: string,
): T {
  if (typeof value === "string") {
    if (propertyName && PROTOCOL_CONTROL_VALUE_NAMES.has(propertyName)) {
      return value;
    }
    return redactSensitiveText(value, sensitiveValues) as T;
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }

  const existing = seen.get(value);
  if (existing !== undefined) {
    return existing as T;
  }
  if (Array.isArray(value)) {
    const clone: unknown[] = [];
    seen.set(value, clone);
    for (const entry of value) {
      clone.push(redactSerializableValue(entry, sensitiveValues, seen, propertyName));
    }
    return clone as T;
  }

  const clone: Record<string, unknown> = {};
  seen.set(value, clone);
  for (const [key, entry] of Object.entries(value)) {
    const safeKey = PROTOCOL_PROPERTY_NAMES.has(key)
      ? key
      : redactSensitiveKey(key, sensitiveValues);
    clone[safeKey] = redactSerializableValue(
      entry,
      sensitiveValues,
      seen,
      key,
    );
  }
  return clone as T;
}

function redactSensitiveKey(key: string, sensitiveValues: readonly string[]): string {
  return sensitiveValues.some((value) => value.length > 0 && value === key)
    ? "[REDACTED]"
    : key;
}
