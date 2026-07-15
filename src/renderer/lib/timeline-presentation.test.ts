import { describe, expect, it } from "vitest";

import type { TimelineItem } from "./acp";
import {
  nextExecutionDisclosureOpen,
  projectTimelinePresentation,
  summarizeExecutionGroup,
} from "./timeline-presentation";

const receivedAt = "2026-07-15T00:00:00.000Z";

function message(
  id: string,
  role: "user" | "agent" | "thought",
  text: string,
  streaming = false,
): TimelineItem {
  return {
    kind: "message",
    id,
    role,
    text,
    contextFiles: [],
    messageId: id,
    receivedAt,
    source: "remote",
    streaming,
  };
}

function tool(id: string, status: "in_progress" | "completed" | "failed"): TimelineItem {
  return {
    kind: "tool",
    id,
    toolCallId: id,
    title: `Tool ${id}`,
    toolKind: "read",
    status,
    output: "",
    locations: [],
    receivedAt,
  };
}

describe("conversation timeline presentation", () => {
  it.each([
    [false, "idle", "working", true, "opens when work starts"],
    [false, "failed", "working", true, "opens when work restarts"],
    [false, "working", "working", false, "preserves a manual close while streaming"],
    [true, "working", "working", true, "preserves an open group while streaming"],
    [true, "working", "idle", false, "closes after successful work"],
    [false, "working", "idle", false, "keeps a closed successful group closed"],
    [true, "working", "failed", true, "keeps a failed group visible"],
    [false, "working", "failed", true, "reopens a group when work fails"],
    [false, "failed", "failed", false, "allows a failed group to be closed"],
    [true, "idle", "idle", true, "allows a completed group to be reopened"],
  ] as const)("disclosure %s: %s → %s = %s (%s)", (currentOpen, previousTone, nextTone, expected, _label) => {
    expect(nextExecutionDisclosureOpen(currentOpen, previousTone, nextTone)).toBe(expected);
  });

  it("groups interleaved thought, tool, and plan entries without changing their order", () => {
    const thoughtBefore = message("thought-before", "thought", "先检查");
    const readTool = tool("tool-read", "completed");
    const thoughtAfter = message("thought-after", "thought", "继续分析");
    const plan: TimelineItem = {
      kind: "plan",
      id: "plan-current",
      title: "执行计划",
      planId: null,
      entries: [],
      note: null,
      receivedAt,
    };

    expect(projectTimelinePresentation([
      message("user-1", "user", "检查项目"),
      thoughtBefore,
      readTool,
      thoughtAfter,
      plan,
      message("agent-1", "agent", "检查完成"),
    ])).toEqual([
      expect.objectContaining({ type: "message", item: expect.objectContaining({ id: "user-1" }) }),
      {
        type: "execution",
        id: "execution-thought-before",
        items: [thoughtBefore, readTool, thoughtAfter, plan],
      },
      expect.objectContaining({ type: "message", item: expect.objectContaining({ id: "agent-1" }) }),
    ]);
  });

  it("starts a new execution group after a conversational message boundary", () => {
    const result = projectTimelinePresentation([
      message("thought-1", "thought", "第一轮分析"),
      message("agent-1", "agent", "第一轮回答"),
      tool("tool-2", "completed"),
      message("user-2", "user", "继续"),
      message("thought-2", "thought", "第二轮分析"),
    ]);

    expect(result.map((entry) => entry.type)).toEqual([
      "execution",
      "message",
      "execution",
      "message",
      "execution",
    ]);
  });

  it("summarizes active and failed execution groups from real tool status", () => {
    expect(summarizeExecutionGroup([
      message("thought", "thought", "分析", true) as Extract<TimelineItem, { kind: "message" }> & { role: "thought" },
      tool("tool", "in_progress") as Extract<TimelineItem, { kind: "tool" }>,
    ])).toMatchObject({ label: "Grok 正在执行", tone: "working" });

    expect(summarizeExecutionGroup([
      tool("tool", "failed") as Extract<TimelineItem, { kind: "tool" }>,
    ])).toMatchObject({ label: "执行过程有错误", tone: "failed" });
  });
});
