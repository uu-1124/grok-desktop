import type {
  AvailableCommand,
  SessionConfigOption,
  SessionReadyPayload,
  TurnOutcome,
} from "../../shared/contracts";

export type MessageRole = "user" | "agent" | "thought";
export type ToolStatus = "pending" | "in_progress" | "completed" | "failed" | "unknown";
export type PlanStatus = "pending" | "in_progress" | "completed";

export interface MessageTimelineItem {
  kind: "message";
  id: string;
  role: MessageRole;
  text: string;
  contextFiles: string[];
  messageId: string | null;
  receivedAt: string;
  streaming: boolean;
  source: "local" | "remote";
}

export interface ToolTimelineItem {
  kind: "tool";
  id: string;
  toolCallId: string;
  title: string;
  toolKind: string;
  status: ToolStatus;
  output: string;
  locations: Array<{ path: string; line?: number }>;
  rawInput?: unknown;
  rawOutput?: unknown;
  receivedAt: string;
}

export interface PlanTimelineItem {
  kind: "plan";
  id: string;
  title: string;
  planId: string | null;
  entries: PlanEntryView[];
  note: string | null;
  receivedAt: string;
}

export type TimelineItem = MessageTimelineItem | ToolTimelineItem | PlanTimelineItem;

export interface PlanEntryView {
  content: string;
  priority: string;
  status: PlanStatus;
}

export interface ChangeRecord {
  path: string;
  oldText: string | null;
  newText: string;
  toolCallId: string;
  receivedAt: string;
}

export type DiffLineKind = "context" | "added" | "removed";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

export interface DiffHunk {
  lines: DiffLine[];
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  omittedBefore: number;
  omittedAfter: number;
}

export interface ActivityRecord {
  id: string;
  type: string;
  label: string;
  detail: string;
  status?: ToolStatus;
  receivedAt: string;
  raw: Record<string, unknown>;
  unknown: boolean;
}

export interface UsageView {
  contextUsed: number | null;
  contextSize: number | null;
  totalTokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  thoughtTokens: number | null;
  cost: { amount: number; currency: string } | null;
}

export interface SessionViewState {
  timeline: TimelineItem[];
  activity: ActivityRecord[];
  plan: PlanEntryView[];
  planNote: string | null;
  activePlanId: string | null;
  changes: ChangeRecord[];
  currentModeId: string | null;
  configOptions: SessionConfigOption[];
  availableCommands: AvailableCommand[];
  usage: UsageView | null;
  stopReason: string | null;
  turnOutcome: TurnOutcome | null;
  turnError: string | null;
}

const KNOWN_UPDATE_TYPES = new Set([
  "user_message_chunk",
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
  "plan_update",
  "plan_removed",
  "available_commands_update",
  "current_mode_update",
  "config_option_update",
  "session_info_update",
  "usage_update",
]);

const BACKGROUND_ACTIVITY_TYPES = new Set([
  "user_message_chunk",
  "agent_message_chunk",
  "agent_thought_chunk",
  "plan",
  "plan_update",
  "plan_removed",
  "available_commands_update",
  "config_option_update",
  "session_info_update",
  "usage_update",
]);

export function createEmptySessionView(): SessionViewState {
  return {
    timeline: [],
    activity: [],
    plan: [],
    planNote: null,
    activePlanId: null,
    changes: [],
    currentModeId: null,
    configOptions: [],
    availableCommands: [],
    usage: null,
    stopReason: null,
    turnOutcome: null,
    turnError: null,
  };
}

export function projectVisibleActivity(activity: readonly ActivityRecord[]): {
  visible: ActivityRecord[];
  hiddenCount: number;
} {
  const visible = activity.filter((record) =>
    record.unknown || record.status === "failed" || !BACKGROUND_ACTIVITY_TYPES.has(record.type),
  );
  return { visible, hiddenCount: activity.length - visible.length };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maximum) : null;
}

function normalizeConfigValues(value: unknown): NonNullable<SessionConfigOption["options"]> {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.slice(0, 256).flatMap((candidate): NonNullable<SessionConfigOption["options"]> => {
    if (!isRecord(candidate)) return [];
    const optionValue = normalizedText(candidate.value, 1_024);
    if (!optionValue || seen.has(optionValue)) return [];
    seen.add(optionValue);
    const name = normalizedText(candidate.name, 8_192) ?? optionValue;
    const description = normalizedText(candidate.description, 8_192);
    return [{
      value: optionValue,
      name,
      ...(description ? { description } : {}),
    }];
  });
}

export function normalizeSessionConfigOptions(value: unknown): SessionConfigOption[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.slice(0, 256).flatMap((candidate): SessionConfigOption[] => {
    if (!isRecord(candidate)) return [];
    const id = normalizedText(candidate.id, 1_024);
    const name = normalizedText(candidate.name, 8_192);
    const type = candidate.type;
    if (!id || !name || seen.has(id) || (type !== "select" && type !== "boolean")) return [];

    const description = normalizedText(candidate.description, 8_192);
    const category = normalizedText(candidate.category, 8_192);
    const common = {
      id,
      name,
      readOnly: candidate.readOnly !== false,
      ...(description ? { description } : {}),
      ...(category ? { category } : {}),
    };

    if (type === "boolean") {
      if (typeof candidate.currentValue !== "boolean") return [];
      seen.add(id);
      return [{ ...common, type, currentValue: candidate.currentValue }];
    }

    if (typeof candidate.currentValue !== "string") return [];
    const options = normalizeConfigValues(candidate.options);
    if (options.length === 0) return [];
    seen.add(id);
    return [{
      ...common,
      type,
      currentValue: candidate.currentValue.slice(0, 1_024),
      options,
    }];
  });
}

export function normalizeAvailableCommands(value: unknown): AvailableCommand[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.slice(0, 256).flatMap((candidate) => {
    if (!isRecord(candidate)) return [];
    const name = normalizedText(candidate.name, 1_024);
    if (!name || seen.has(name)) return [];
    seen.add(name);
    const description = normalizedText(candidate.description, 8_192) ?? "";
    const input = isRecord(candidate.input) ? candidate.input : null;
    const inputHint = normalizedText(candidate.inputHint ?? input?.hint, 8_192);
    return [{ name, description, inputHint }];
  });
}

export function applySessionReady(
  previous: SessionViewState,
  ready: SessionReadyPayload,
): SessionViewState {
  return {
    ...previous,
    timeline: ready.loaded
      ? previous.timeline.map((item) => item.kind === "message" && item.streaming
        ? { ...item, streaming: false }
        : item)
      : previous.timeline,
    currentModeId: ready.currentModeId,
    configOptions: normalizeSessionConfigOptions(ready.configOptions),
    availableCommands: normalizeAvailableCommands(ready.availableCommands),
  };
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function safeJson(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function contentToText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(contentToText).filter(Boolean).join("\n");
  if (!isRecord(value)) return "";

  const type = stringValue(value.type);
  if (typeof value.text === "string") return value.text;
  if (type === "image") return `[图像 · ${stringValue(value.mimeType, "未知格式")}]`;
  if (type === "audio") return `[音频 · ${stringValue(value.mimeType, "未知格式")}]`;
  if (type === "resource_link") {
    const title = stringValue(value.title) || stringValue(value.name, "资源");
    return `引用文件 · ${title}`;
  }
  if (isRecord(value.resource)) {
    return `引用文件 · ${resourceNameFromUri(stringValue(value.resource.uri))}`;
  }
  if (value.content !== undefined) return contentToText(value.content);
  return "";
}

function resourceNameFromUri(uri: string): string {
  if (!uri) return "资源";
  try {
    const pathname = new URL(uri).pathname;
    const name = pathname.split("/").filter(Boolean).at(-1);
    return name ? decodeURIComponent(name) : "资源";
  } catch {
    return "资源";
  }
}

function updateType(update: Record<string, unknown>): string {
  return stringValue(update.sessionUpdate) || stringValue(update.type) || "unknown";
}

function activityText(type: string, update: Record<string, unknown>): Pick<ActivityRecord, "label" | "detail" | "status"> {
  switch (type) {
    case "user_message_chunk": return { label: "收到你的消息", detail: contentToText(update.content).slice(0, 120) };
    case "agent_message_chunk": return { label: "Grok 正在回复", detail: contentToText(update.content).slice(0, 120) };
    case "agent_thought_chunk": return { label: "正在分析", detail: contentToText(update.content).slice(0, 120) };
    case "tool_call":
    case "tool_call_update": return {
      label: stringValue(update.title, "工具调用"),
      detail: stringValue(update.kind, "工具"),
      status: normalizeToolStatus(update.status),
    };
    case "plan": return { label: "执行计划已更新", detail: `${Array.isArray(update.entries) ? update.entries.length : 0} 个步骤` };
    case "plan_update": return { label: "执行计划已更新", detail: "计划内容发生变化" };
    case "plan_removed": return { label: "执行计划已移除", detail: stringValue(update.planId) };
    case "current_mode_update": return { label: "会话模式已切换", detail: stringValue(update.currentModeId) };
    case "config_option_update": return { label: "会话配置已更新", detail: "配置选项发生变化" };
    case "usage_update": return { label: "上下文用量已更新", detail: usageSummary(update) };
    case "available_commands_update": return { label: "可用命令已更新", detail: `${Array.isArray(update.availableCommands) ? update.availableCommands.length : 0} 个命令` };
    case "session_info_update": return { label: "会话信息已更新", detail: stringValue(update.title) };
    default: return { label: `未识别更新 · ${type}`, detail: "已保留原始协议数据" };
  }
}

function usageSummary(update: Record<string, unknown>): string {
  const usage = mergeUsageUpdate(null, update);
  if (!usage) return "用量数据已同步";
  const parts: string[] = [];
  if (usage.contextUsed !== null && usage.contextSize !== null) {
    parts.push(`${usage.contextUsed.toLocaleString()} / ${usage.contextSize.toLocaleString()} tokens`);
  } else if (usage.totalTokens !== null) {
    parts.push(`${usage.totalTokens.toLocaleString()} tokens`);
  }
  if (usage.cost) parts.push(`${usage.cost.amount.toLocaleString()} ${usage.cost.currency}`);
  return parts.join(" · ") || "用量数据已同步";
}

export function mergeUsageUpdate(
  previous: UsageView | null,
  update: Record<string, unknown>,
): UsageView | null {
  const nested = isRecord(update.usage) ? update.usage : null;
  const sources = nested ? [update, nested] : [update];
  const next: UsageView = previous ? { ...previous, cost: previous.cost ? { ...previous.cost } : null } : {
    contextUsed: null,
    contextSize: null,
    totalTokens: null,
    inputTokens: null,
    outputTokens: null,
    thoughtTokens: null,
    cost: null,
  };
  let changed = false;

  const assignTokenNumber = (
    key: keyof Omit<UsageView, "cost">,
    candidates: readonly string[],
    nullable = false,
  ) => {
    for (const source of sources) {
      for (const candidate of candidates) {
        if (nullable && Object.prototype.hasOwnProperty.call(source, candidate) && source[candidate] === null) {
          next[key] = null;
          changed = true;
          return;
        }
        const value = nonNegativeInteger(source[candidate]);
        if (value !== null) {
          next[key] = value;
          changed = true;
          return;
        }
      }
    }
  };
  assignTokenNumber("contextUsed", ["used", "usedTokens"]);
  assignTokenNumber("contextSize", ["size", "contextWindow", "contextWindowSize"]);
  assignTokenNumber("totalTokens", ["totalTokens"]);
  assignTokenNumber("inputTokens", ["inputTokens"]);
  assignTokenNumber("outputTokens", ["outputTokens"]);
  assignTokenNumber("thoughtTokens", ["thoughtTokens"], true);

  for (const source of sources) {
    if (source.cost === null) {
      next.cost = null;
      changed = true;
      break;
    }
    if (!isRecord(source.cost)) continue;
    const amount = nonNegativeNumber(source.cost.amount);
    const currency = normalizedText(source.cost.currency, 12);
    if (amount !== null && currency) {
      next.cost = { amount, currency: currency.toUpperCase() };
      changed = true;
      break;
    }
  }

  return changed ? next : previous;
}

function normalizeToolStatus(value: unknown): ToolStatus {
  return value === "pending" || value === "in_progress" || value === "completed" || value === "failed"
    ? value
    : "unknown";
}

function normalizePlanEntries(value: unknown): PlanEntryView[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.content !== "string") return [];
    const status = entry.status === "in_progress" || entry.status === "completed" ? entry.status : "pending";
    return [{ content: entry.content, priority: stringValue(entry.priority, "medium"), status }];
  });
}

function mergeMessage(
  timeline: TimelineItem[],
  role: MessageRole,
  text: string,
  messageId: string | null,
  receivedAt: string,
): TimelineItem[] {
  if (!text) return timeline;
  const next = [...timeline];
  const lastIndex = next.length - 1;
  const last = next[lastIndex];
  if (last?.kind === "message" && last.role === role) {
    const sameMessage = messageId ? last.messageId === messageId : last.streaming;
    const localEcho = role === "user" && last.source === "local";
    if (sameMessage || localEcho) {
      next[lastIndex] = {
        ...last,
        messageId: messageId ?? last.messageId,
        source: localEcho ? "local" : "remote",
        streaming: role !== "user",
        text: localEcho ? last.text : `${last.text}${text}`,
      };
      return next;
    }
  }

  next.push({
    kind: "message",
    id: `message-${messageId ?? `${receivedAt}-${next.length}`}`,
    role,
    text,
    contextFiles: [],
    messageId,
    receivedAt,
    streaming: role !== "user",
    source: "remote",
  });
  return next;
}

function contextFileName(value: unknown): string | null {
  if (!isRecord(value)) return null;
  if (value.type === "resource_link") {
    return normalizedText(value.title, 1_024) ??
      normalizedText(value.name, 1_024) ??
      resourceNameFromUri(stringValue(value.uri));
  }
  if (value.type === "resource" && isRecord(value.resource)) {
    return resourceNameFromUri(stringValue(value.resource.uri));
  }
  return null;
}

function mergeContextFile(
  timeline: TimelineItem[],
  fileName: string,
  messageId: string | null,
  receivedAt: string,
): TimelineItem[] {
  const next = [...timeline];
  const index = findLastIndex(next, (item) =>
    item.kind === "message" && item.role === "user"
  );
  const previous = index >= 0 ? next[index] as MessageTimelineItem : null;
  if (previous) {
    next[index] = {
      ...previous,
      messageId: previous.messageId ?? messageId,
      contextFiles: previous.contextFiles.includes(fileName)
        ? previous.contextFiles
        : [...previous.contextFiles, fileName],
    };
    return next;
  }
  next.push({
    kind: "message",
    id: `message-${messageId ?? `${receivedAt}-${next.length}`}`,
    role: "user",
    text: "",
    contextFiles: [fileName],
    messageId,
    receivedAt,
    streaming: false,
    source: "remote",
  });
  return next;
}

function extractLocations(value: unknown): Array<{ path: string; line?: number }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((location) => {
    if (!isRecord(location) || typeof location.path !== "string") return [];
    return [{ path: location.path, ...(typeof location.line === "number" ? { line: location.line } : {}) }];
  });
}

function extractChanges(value: unknown, toolCallId: string, receivedAt: string): ChangeRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((content) => {
    if (!isRecord(content) || content.type !== "diff" || typeof content.path !== "string" || typeof content.newText !== "string") return [];
    return [{
      path: content.path,
      oldText: typeof content.oldText === "string" ? content.oldText : null,
      newText: content.newText,
      toolCallId,
      receivedAt,
    }];
  });
}

function upsertChanges(existing: ChangeRecord[], incoming: ChangeRecord[]): ChangeRecord[] {
  const next = [...existing];
  for (const change of incoming) {
    const index = next.findIndex((item) => item.path === change.path);
    if (index < 0) {
      next.push(change);
      continue;
    }
    const previous = next[index]!;
    const baseline = previous.oldText === null &&
      previous.toolCallId === change.toolCallId &&
      change.oldText !== null
      ? change.oldText
      : previous.oldText;
    const createdThenDeleted = baseline === null &&
      previous.toolCallId !== change.toolCallId &&
      change.oldText === previous.newText &&
      change.newText === "";
    const restoredBaseline = baseline !== null &&
      baseline !== "" &&
      change.newText === baseline;
    if (createdThenDeleted || restoredBaseline) {
      next.splice(index, 1);
      continue;
    }
    next[index] = {
      ...change,
      oldText: baseline,
    };
  }
  return next;
}

function upsertTool(timeline: TimelineItem[], update: Record<string, unknown>, receivedAt: string): TimelineItem[] {
  const toolCallId = stringValue(update.toolCallId, `unknown-${receivedAt}`);
  const next = [...timeline];
  const index = next.findIndex((item) => item.kind === "tool" && item.toolCallId === toolCallId);
  const previous = index >= 0 ? next[index] as ToolTimelineItem : null;
  const contentText = update.content === undefined ? undefined : contentToText(update.content);
  const tool: ToolTimelineItem = {
    kind: "tool",
    id: `tool-${toolCallId}`,
    toolCallId,
    title: typeof update.title === "string" ? update.title : previous?.title ?? "工具调用",
    toolKind: typeof update.kind === "string" ? update.kind : previous?.toolKind ?? "other",
    status: update.status === undefined || update.status === null ? previous?.status ?? "unknown" : normalizeToolStatus(update.status),
    output: contentText ?? previous?.output ?? "",
    locations: update.locations === undefined || update.locations === null ? previous?.locations ?? [] : extractLocations(update.locations),
    rawInput: update.rawInput === undefined ? previous?.rawInput : update.rawInput,
    rawOutput: update.rawOutput === undefined ? previous?.rawOutput : update.rawOutput,
    receivedAt,
  };
  if (index >= 0) next[index] = tool;
  else next.push(tool);
  return next;
}

export function addLocalPrompt(
  previous: SessionViewState,
  text: string,
  receivedAt: string,
  contextFiles: readonly string[] = [],
): SessionViewState {
  const timeline: TimelineItem[] = previous.timeline.map((item) => item.kind === "message" ? { ...item, streaming: false } : item);
  timeline.push({
    kind: "message",
    id: `local-${receivedAt}-${timeline.length}`,
    role: "user",
    text,
    contextFiles: [...new Set(contextFiles)],
    messageId: null,
    receivedAt,
    streaming: false,
    source: "local",
  });
  return {
    ...previous,
    timeline,
    stopReason: null,
    turnOutcome: null,
    turnError: null,
  };
}

export function finishTurn(
  previous: SessionViewState,
  stopReason: string,
  outcome: Exclude<TurnOutcome, "failed"> = "end_turn",
): SessionViewState {
  return {
    ...previous,
    timeline: previous.timeline.map((item) => item.kind === "message" ? { ...item, streaming: false } : item),
    stopReason,
    turnOutcome: outcome,
    turnError: null,
  };
}

export function failTurn(previous: SessionViewState, message: string): SessionViewState {
  return {
    ...previous,
    timeline: previous.timeline.map((item) => item.kind === "message" ? { ...item, streaming: false } : item),
    stopReason: null,
    turnOutcome: "failed",
    turnError: message,
  };
}

export function applySessionUpdate(
  previous: SessionViewState,
  update: Record<string, unknown>,
  receivedAt: string,
): SessionViewState {
  const type = updateType(update);
  const known = KNOWN_UPDATE_TYPES.has(type);
  const activityMeta = activityText(type, update);
  const activityRecord: ActivityRecord = {
    id: `${receivedAt}-${previous.activity.length}-${type}`,
    type,
    label: activityMeta.label,
    detail: activityMeta.detail,
    status: activityMeta.status,
    receivedAt,
    raw: update,
    unknown: !known,
  };
  const activity = mergeActivity(previous.activity, activityRecord, update);

  let next: SessionViewState = {
    ...previous,
    activity,
    stopReason: null,
    turnOutcome: null,
    turnError: null,
  };

  if (type === "user_message_chunk" || type === "agent_message_chunk" || type === "agent_thought_chunk") {
    const role: MessageRole = type === "user_message_chunk" ? "user" : type === "agent_thought_chunk" ? "thought" : "agent";
    const contextFile = role === "user" ? contextFileName(update.content) : null;
    if (contextFile) {
      next.timeline = mergeContextFile(
        previous.timeline,
        contextFile,
        typeof update.messageId === "string" ? update.messageId : null,
        receivedAt,
      );
      return next;
    }
    next.timeline = mergeMessage(
      previous.timeline,
      role,
      contentToText(update.content),
      typeof update.messageId === "string" ? update.messageId : null,
      receivedAt,
    );
    return next;
  }

  if (type === "tool_call" || type === "tool_call_update") {
    next.timeline = upsertTool(previous.timeline, update, receivedAt);
    const toolCallId = stringValue(update.toolCallId, `unknown-${receivedAt}`);
    next.changes = upsertChanges(previous.changes, extractChanges(update.content, toolCallId, receivedAt));
    return next;
  }

  if (type === "plan") {
    const entries = normalizePlanEntries(update.entries);
    next.plan = entries;
    next.planNote = null;
    next.activePlanId = null;
    next.timeline = upsertPlan(previous.timeline, null, entries, null, receivedAt);
    return next;
  }

  if (type === "plan_update") {
    const plan = isRecord(update.plan) ? update.plan : null;
    const planId = typeof plan?.planId === "string" && plan.planId ? plan.planId : null;
    if (!plan || !planId) return next;

    let entries: PlanEntryView[];
    let note: string | null;
    if (plan.type === "items") {
      entries = normalizePlanEntries(plan.entries);
      note = null;
    } else if (plan.type === "markdown") {
      entries = [];
      note = stringValue(plan.content) || null;
    } else if (plan.type === "file") {
      entries = [];
      note = stringValue(plan.uri) || null;
    } else {
      return next;
    }

    next.plan = entries;
    next.planNote = note;
    next.activePlanId = planId;
    next.timeline = upsertPlan(previous.timeline, planId, entries, note, receivedAt);
    return next;
  }

  if (type === "plan_removed") {
    const planId = typeof update.planId === "string" && update.planId ? update.planId : null;
    if (!planId) return next;
    next.timeline = previous.timeline.filter((item) => item.kind !== "plan" || item.planId !== planId);
    if (previous.activePlanId === planId) {
      next.plan = [];
      next.planNote = null;
      next.activePlanId = null;
    }
    return next;
  }

  if (type === "current_mode_update") {
    next.currentModeId = stringValue(update.currentModeId) || null;
    return next;
  }

  if (type === "config_option_update") {
    if (Array.isArray(update.configOptions)) {
      next.configOptions = normalizeSessionConfigOptions(update.configOptions);
    }
    return next;
  }

  if (type === "available_commands_update") {
    if (Array.isArray(update.availableCommands)) {
      next.availableCommands = normalizeAvailableCommands(update.availableCommands);
    }
    return next;
  }

  if (type === "usage_update") {
    next.usage = mergeUsageUpdate(previous.usage, update);
  }

  return next;
}

function mergeActivity(
  existing: ActivityRecord[],
  incoming: ActivityRecord,
  update: Record<string, unknown>,
): ActivityRecord[] {
  const next = [...existing];
  const isStreamChunk =
    incoming.type === "user_message_chunk" ||
    incoming.type === "agent_message_chunk" ||
    incoming.type === "agent_thought_chunk";

  if (isStreamChunk) {
    const previous = next.at(-1);
    if (previous?.type === incoming.type) {
      const combined = `${previous.detail}${incoming.detail}`.trim();
      next[next.length - 1] = {
        ...previous,
        detail: combined.length > 180 ? `${combined.slice(0, 177)}…` : combined,
        raw: incoming.raw,
        receivedAt: incoming.receivedAt,
      };
      return next;
    }
  }

  if (incoming.type === "tool_call" || incoming.type === "tool_call_update") {
    const toolCallId = stringValue(update.toolCallId);
    const index = toolCallId
      ? findLastIndex(next, (record) => stringValue(record.raw.toolCallId) === toolCallId)
      : -1;
    if (index >= 0) {
      const previous = next[index]!;
      next[index] = {
        ...incoming,
        id: previous.id,
        label: typeof update.title === "string" ? incoming.label : previous.label,
        detail: typeof update.kind === "string" ? incoming.detail : previous.detail,
        status: update.status === undefined || update.status === null
          ? previous.status
          : incoming.status,
      };
      return next;
    }
  }

  if (
    incoming.type === "usage_update" ||
    incoming.type === "available_commands_update" ||
    incoming.type === "current_mode_update" ||
    incoming.type === "config_option_update" ||
    incoming.type === "session_info_update"
  ) {
    const index = findLastIndex(next, (record) => record.type === incoming.type);
    if (index >= 0) {
      next[index] = { ...incoming, id: next[index]!.id };
      return next;
    }
  }

  next.push(incoming);
  return next.slice(-500);
}

function findLastIndex<T>(items: T[], predicate: (item: T, index: number) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index]!, index)) return index;
  }
  return -1;
}

function upsertPlan(
  timeline: TimelineItem[],
  planId: string | null,
  entries: PlanEntryView[],
  note: string | null,
  receivedAt: string,
): TimelineItem[] {
  const next = [...timeline];
  const lastUserIndex = findLastIndex(next, (item) => item.kind === "message" && item.role === "user");
  const index = findLastIndex(next, (item, itemIndex) =>
    item.kind === "plan" && (
      planId !== null
        ? item.planId === planId
        : item.planId === null && itemIndex > lastUserIndex
    )
  );
  const previous = index >= 0 ? next[index] as PlanTimelineItem : null;
  const item: PlanTimelineItem = {
    kind: "plan",
    id: previous?.id ?? `plan-${receivedAt}-${next.length}`,
    title: "执行计划",
    planId,
    entries: entries.map((entry) => ({ ...entry })),
    note,
    receivedAt,
  };
  if (index >= 0) next[index] = item;
  else next.push(item);
  return next;
}

export function summarizeRaw(value: unknown): string {
  return safeJson(value);
}

const MAX_PERMISSION_DETAIL_TEXT_LENGTH = 2_048;
const MAX_PERMISSION_DETAILS_LENGTH = 12_000;
const MAX_PERMISSION_DETAIL_DEPTH = 6;
const MAX_PERMISSION_DETAIL_ENTRIES = 64;

export function redactPermissionText(value: string): string {
  let redacted = value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{6,}\b/giu, "Bearer [已隐藏]")
    .replace(/\b(?:sk|xai)-[A-Za-z0-9._-]{8,}\b/giu, "[已隐藏]")
    .replace(/((?:--)?(?:api[-_]?key|token|password|passwd|secret)\s+)(?:"[^"]*"|'[^']*'|\S+)/giu, "$1[已隐藏]")
    .replace(/((?:authorization|api[-_]?key|token|password|passwd|secret)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/giu, "$1[已隐藏]");
  if (redacted.length > MAX_PERMISSION_DETAIL_TEXT_LENGTH) {
    redacted = `${redacted.slice(0, MAX_PERMISSION_DETAIL_TEXT_LENGTH - 1)}…`;
  }
  return redacted;
}

export function summarizePermissionDetails(value: unknown): string {
  const sanitized = sanitizePermissionValue(value, null, 0, new WeakSet<object>());
  const summary = safeJson(sanitized);
  return summary.length > MAX_PERMISSION_DETAILS_LENGTH
    ? `${summary.slice(0, MAX_PERMISSION_DETAILS_LENGTH - 1)}…`
    : summary;
}

export function basename(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).pop() || path;
}

export function formatClock(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

export function formatRelativeDate(value: string, now = new Date()): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return formatClock(value);
  if (date.getFullYear() !== now.getFullYear()) {
    return new Intl.DateTimeFormat("zh-CN", {
      year: "numeric",
      month: "numeric",
      day: "numeric",
    }).format(date);
  }
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(date);
}

export function createLineDiff(change: ChangeRecord): DiffLine[] {
  const oldLines = splitDiffLines(change.oldText ?? "");
  const newLines = splitDiffLines(change.newText);
  let sharedPrefixLength = 0;
  while (
    sharedPrefixLength < oldLines.length &&
    sharedPrefixLength < newLines.length &&
    oldLines[sharedPrefixLength] === newLines[sharedPrefixLength]
  ) {
    sharedPrefixLength += 1;
  }

  let sharedSuffixLength = 0;
  while (
    sharedSuffixLength < oldLines.length - sharedPrefixLength &&
    sharedSuffixLength < newLines.length - sharedPrefixLength &&
    oldLines[oldLines.length - sharedSuffixLength - 1] ===
      newLines[newLines.length - sharedSuffixLength - 1]
  ) {
    sharedSuffixLength += 1;
  }

  const oldMiddle = oldLines.slice(
    sharedPrefixLength,
    oldLines.length - sharedSuffixLength,
  );
  const newMiddle = newLines.slice(
    sharedPrefixLength,
    newLines.length - sharedSuffixLength,
  );
  const prefix: DiffLine[] = oldLines.slice(0, sharedPrefixLength).map((text, index) => ({
    kind: "context",
    text,
    oldLine: index + 1,
    newLine: index + 1,
  }));
  const suffix: DiffLine[] = oldLines.slice(oldLines.length - sharedSuffixLength).map((text, index) => ({
    kind: "context",
    text,
    oldLine: oldLines.length - sharedSuffixLength + index + 1,
    newLine: newLines.length - sharedSuffixLength + index + 1,
  }));

  const cellCount = oldMiddle.length * newMiddle.length;
  if (cellCount > 2_000_000) {
    return [
      ...prefix,
      ...oldMiddle.map((text, index) => ({
        kind: "removed" as const,
        text,
        oldLine: sharedPrefixLength + index + 1,
        newLine: null,
      })),
      ...newMiddle.map((text, index) => ({
        kind: "added" as const,
        text,
        oldLine: null,
        newLine: sharedPrefixLength + index + 1,
      })),
      ...suffix,
    ];
  }

  const table = Array.from({ length: oldMiddle.length + 1 }, () => new Uint32Array(newMiddle.length + 1));
  for (let oldIndex = 1; oldIndex <= oldMiddle.length; oldIndex += 1) {
    for (let newIndex = 1; newIndex <= newMiddle.length; newIndex += 1) {
      table[oldIndex]![newIndex] = oldMiddle[oldIndex - 1] === newMiddle[newIndex - 1]
        ? table[oldIndex - 1]![newIndex - 1]! + 1
        : Math.max(table[oldIndex - 1]![newIndex]!, table[oldIndex]![newIndex - 1]!);
    }
  }

  const reversed: DiffLine[] = [];
  let oldIndex = oldMiddle.length;
  let newIndex = newMiddle.length;
  while (oldIndex > 0 || newIndex > 0) {
    if (oldIndex > 0 && newIndex > 0 && oldMiddle[oldIndex - 1] === newMiddle[newIndex - 1]) {
      reversed.push({
        kind: "context",
        text: oldMiddle[oldIndex - 1]!,
        oldLine: sharedPrefixLength + oldIndex,
        newLine: sharedPrefixLength + newIndex,
      });
      oldIndex -= 1;
      newIndex -= 1;
    } else if (newIndex > 0 && (oldIndex === 0 || table[oldIndex - 1]![newIndex]! <= table[oldIndex]![newIndex - 1]!)) {
      reversed.push({
        kind: "added",
        text: newMiddle[newIndex - 1]!,
        oldLine: null,
        newLine: sharedPrefixLength + newIndex,
      });
      newIndex -= 1;
    } else {
      reversed.push({
        kind: "removed",
        text: oldMiddle[oldIndex - 1]!,
        oldLine: sharedPrefixLength + oldIndex,
        newLine: null,
      });
      oldIndex -= 1;
    }
  }
  return [...prefix, ...reversed.reverse(), ...suffix];
}

export function createDiffHunks(
  diff: readonly DiffLine[],
  contextLineCount = 3,
): DiffHunk[] {
  if (!Number.isSafeInteger(contextLineCount) || contextLineCount < 0) {
    throw new TypeError("contextLineCount must be a non-negative safe integer.");
  }

  const changeIndexes = diff.flatMap((line, index) =>
    line.kind === "context" ? [] : [index],
  );
  if (changeIndexes.length === 0) return [];

  const ranges: Array<{ start: number; end: number }> = [];
  for (const changeIndex of changeIndexes) {
    const start = Math.max(0, changeIndex - contextLineCount);
    const end = Math.min(diff.length, changeIndex + contextLineCount + 1);
    const previous = ranges.at(-1);
    if (previous && start <= previous.end) {
      previous.end = Math.max(previous.end, end);
    } else {
      ranges.push({ start, end });
    }
  }

  return ranges.map((range, index) => {
    const lines = diff.slice(range.start, range.end).map((line) => ({ ...line }));
    const oldCount = lines.reduce((count, line) => count + (line.oldLine === null ? 0 : 1), 0);
    const newCount = lines.reduce((count, line) => count + (line.newLine === null ? 0 : 1), 0);
    const oldStart = lines.find((line) => line.oldLine !== null)?.oldLine ??
      Math.max(1, countLineNumbersBefore(diff, range.start, "oldLine"));
    const newStart = lines.find((line) => line.newLine !== null)?.newLine ??
      Math.max(1, countLineNumbersBefore(diff, range.start, "newLine"));
    return {
      lines,
      oldStart,
      oldCount,
      newStart,
      newCount,
      omittedBefore: range.start - (ranges[index - 1]?.end ?? 0),
      omittedAfter: index === ranges.length - 1 ? diff.length - range.end : 0,
    };
  });
}

export function lineStatsFromDiff(diff: readonly DiffLine[]): { added: number; removed: number } {
  return diff.reduce(
    (stats, line) => {
      if (line.kind === "added") stats.added += 1;
      if (line.kind === "removed") stats.removed += 1;
      return stats;
    },
    { added: 0, removed: 0 },
  );
}

export function lineStats(change: ChangeRecord): { added: number; removed: number } {
  return lineStatsFromDiff(createLineDiff(change));
}

function splitDiffLines(value: string): string[] {
  return value ? value.split("\n") : [];
}

function sanitizePermissionValue(
  value: unknown,
  key: string | null,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (key && isSensitivePermissionKey(key)) return "[已隐藏]";
  if (typeof value === "string") return redactPermissionText(value);
  if (typeof value !== "object" || value === null) return value;
  if (depth >= MAX_PERMISSION_DETAIL_DEPTH) return "[内容已折叠]";
  if (seen.has(value)) return "[循环引用]";
  seen.add(value);

  if (Array.isArray(value)) {
    const entries = value.slice(0, MAX_PERMISSION_DETAIL_ENTRIES).map((entry) =>
      sanitizePermissionValue(entry, null, depth + 1, seen),
    );
    if (value.length > entries.length) entries.push(`[另有 ${value.length - entries.length} 项]`);
    return entries;
  }

  const record: Record<string, unknown> = {};
  const entries = Object.entries(value).slice(0, MAX_PERMISSION_DETAIL_ENTRIES);
  for (const [entryKey, entryValue] of entries) {
    record[entryKey] = sanitizePermissionValue(entryValue, entryKey, depth + 1, seen);
  }
  if (Object.keys(value).length > entries.length) {
    record["…"] = `[另有 ${Object.keys(value).length - entries.length} 个字段]`;
  }
  return record;
}

function isSensitivePermissionKey(value: string): boolean {
  const normalized = value.replace(/[^a-z0-9]/giu, "").toLocaleLowerCase("en-US");
  return normalized === "env" ||
    normalized === "environment" ||
    normalized === "headers" ||
    normalized === "rawoutput" ||
    /(?:authorization|cookie|credential|password|passwd|secret|token|apikey|accesskey|privatekey)/u.test(normalized);
}

function countLineNumbersBefore(
  diff: readonly DiffLine[],
  end: number,
  key: "oldLine" | "newLine",
): number {
  let count = 0;
  for (let index = 0; index < end; index += 1) {
    if (diff[index]?.[key] !== null) count += 1;
  }
  return count;
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
