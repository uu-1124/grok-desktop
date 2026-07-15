import type {
  MessageTimelineItem,
  PlanTimelineItem,
  TimelineItem,
  ToolTimelineItem,
} from "./acp";

export type ConversationMessageTimelineItem = MessageTimelineItem & {
  role: "user" | "agent";
};

export type ExecutionTimelineItem =
  | (MessageTimelineItem & { role: "thought" })
  | ToolTimelineItem
  | PlanTimelineItem;

export interface ConversationMessageEntry {
  type: "message";
  item: ConversationMessageTimelineItem;
}

export interface ExecutionGroupEntry {
  type: "execution";
  id: string;
  items: ExecutionTimelineItem[];
}

export type TimelinePresentationEntry = ConversationMessageEntry | ExecutionGroupEntry;

export interface ExecutionGroupSummary {
  label: string;
  detail: string | null;
  tone: "idle" | "working" | "failed";
}

export function nextExecutionDisclosureOpen(
  currentOpen: boolean,
  previousTone: ExecutionGroupSummary["tone"],
  nextTone: ExecutionGroupSummary["tone"],
): boolean {
  if (previousTone === nextTone) return currentOpen;
  if (nextTone === "working") return true;
  if (previousTone === "working") return nextTone === "failed";
  return currentOpen;
}

export function projectTimelinePresentation(
  timeline: readonly TimelineItem[],
): TimelinePresentationEntry[] {
  const entries: TimelinePresentationEntry[] = [];
  let execution: ExecutionGroupEntry | null = null;

  for (const item of timeline) {
    if (item.kind === "message" && item.role !== "thought") {
      execution = null;
      entries.push({ type: "message", item: item as ConversationMessageTimelineItem });
      continue;
    }

    if (!execution) {
      execution = {
        type: "execution",
        id: `execution-${item.id}`,
        items: [],
      };
      entries.push(execution);
    }
    execution.items.push(item as ExecutionTimelineItem);
  }

  return entries;
}

export function summarizeExecutionGroup(
  items: readonly ExecutionTimelineItem[],
): ExecutionGroupSummary {
  const tools = items.filter((item): item is ToolTimelineItem => item.kind === "tool");
  const thoughtCount = items.filter((item) => item.kind === "message").length;
  const planCount = items.filter((item) => item.kind === "plan").length;
  const failed = tools.some((tool) => tool.status === "failed");
  const working = tools.some((tool) => tool.status === "pending" || tool.status === "in_progress") ||
    items.some((item) => item.kind === "message" && item.streaming);

  const detailParts = [
    thoughtCount > 0 ? `${thoughtCount} 段分析` : null,
    tools.length > 0 ? `${tools.length} 个工具` : null,
    planCount > 0 ? "执行计划" : null,
  ].filter((value): value is string => Boolean(value));

  if (failed) {
    return {
      label: "执行过程有错误",
      detail: detailParts.join(" · ") || null,
      tone: "failed",
    };
  }
  if (working) {
    return {
      label: "Grok 正在执行",
      detail: detailParts.join(" · ") || null,
      tone: "working",
    };
  }
  return {
    label: tools.length > 0 || planCount > 0 ? "执行过程" : "分析过程",
    detail: detailParts.join(" · ") || null,
    tone: "idle",
  };
}
