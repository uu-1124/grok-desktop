import { describe, expect, it } from "vitest";
import {
  addLocalPrompt,
  applySessionReady,
  applySessionUpdate,
  createDiffHunks,
  createEmptySessionView,
  createLineDiff,
  finishTurn,
  formatRelativeDate,
  lineStats,
  lineStatsFromDiff,
  projectVisibleActivity,
  redactPermissionText,
  summarizePermissionDetails,
} from "./acp";

const now = "2026-07-13T12:00:00.000Z";

describe("task date presentation", () => {
  const reference = new Date(2026, 6, 15, 12, 0, 0);

  it("shows time today, month and day this year, and the year for older tasks", () => {
    const today = new Date(2026, 6, 15, 9, 30, 0).toISOString();
    const thisYear = new Date(2026, 6, 14, 9, 30, 0).toISOString();
    const previousYear = new Date(2025, 6, 14, 9, 30, 0).toISOString();

    expect(formatRelativeDate(today, reference)).toMatch(/\d{2}:\d{2}/);
    expect(formatRelativeDate(thisYear, reference)).not.toContain("2026");
    expect(formatRelativeDate(previousYear, reference)).toContain("2025");
    expect(formatRelativeDate("invalid", reference)).toBe("");
  });
});

describe("ACP renderer projection", () => {
  it("merges streamed answer chunks by message id", () => {
    let state = createEmptySessionView();
    state = applySessionUpdate(state, {
      sessionUpdate: "agent_message_chunk",
      messageId: "answer-1",
      content: { type: "text", text: "你好" },
    }, now);
    state = applySessionUpdate(state, {
      sessionUpdate: "agent_message_chunk",
      messageId: "answer-1",
      content: { type: "text", text: "，世界" },
    }, now);

    expect(state.timeline).toHaveLength(1);
    expect(state.timeline[0]).toMatchObject({ kind: "message", role: "agent", text: "你好，世界" });
  });

  it("does not duplicate optimistic user text when ACP echoes chunks", () => {
    let state = addLocalPrompt(createEmptySessionView(), "检查这个项目", now);
    state = applySessionUpdate(state, {
      sessionUpdate: "user_message_chunk",
      messageId: "prompt-1",
      content: { type: "text", text: "检查" },
    }, now);
    state = applySessionUpdate(state, {
      sessionUpdate: "user_message_chunk",
      messageId: "prompt-1",
      content: { type: "text", text: "这个项目" },
    }, now);

    expect(state.timeline).toHaveLength(1);
    expect(state.timeline[0]).toMatchObject({ text: "检查这个项目" });
  });

  it("renders referenced resources without exposing embedded file contents or absolute URIs", () => {
    let state = applySessionUpdate(createEmptySessionView(), {
      sessionUpdate: "user_message_chunk",
      messageId: "prompt",
      content: { type: "text", text: "Review these files" },
    }, now);
    state = applySessionUpdate(state, {
      sessionUpdate: "user_message_chunk",
      messageId: "resource-link",
      content: {
        type: "resource_link",
        name: "package.json",
        uri: "file:///D:/private/project/package.json",
      },
    }, now);
    state = applySessionUpdate(state, {
      sessionUpdate: "user_message_chunk",
      messageId: "embedded-resource",
      content: {
        type: "resource",
        resource: {
          uri: "file:///D:/private/project/secret.ts",
          text: "do-not-render-this-file-body",
        },
      },
    }, now);

    expect(state.timeline).toEqual([expect.objectContaining({
      text: "Review these files",
      contextFiles: ["package.json", "secret.ts"],
    })]);
    expect(JSON.stringify(state.timeline)).not.toContain("do-not-render-this-file-body");
    expect(JSON.stringify(state.timeline)).not.toContain("D:/private");
  });

  it("keeps optimistic file chips attached to the original user message", () => {
    let state = addLocalPrompt(
      createEmptySessionView(),
      "Review this file",
      now,
      ["package.json"],
    );
    state = applySessionUpdate(state, {
      sessionUpdate: "user_message_chunk",
      messageId: "resource-echo",
      content: {
        type: "resource",
        resource: {
          uri: "file:///D:/project/package.json",
          text: "must-not-render",
        },
      },
    }, now);

    expect(state.timeline).toEqual([expect.objectContaining({
      text: "Review this file",
      contextFiles: ["package.json"],
      source: "local",
    })]);
  });

  it("updates tools in place and projects protocol diffs", () => {
    let state = applySessionUpdate(createEmptySessionView(), {
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "修改配置",
      kind: "edit",
      status: "in_progress",
    }, now);
    state = applySessionUpdate(state, {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      status: "completed",
      content: [{ type: "diff", path: "D:\\project\\config.ts", oldText: "a", newText: "a\nb" }],
    }, now);

    expect(state.timeline).toHaveLength(1);
    expect(state.timeline[0]).toMatchObject({ kind: "tool", status: "completed" });
    expect(state.changes).toEqual([expect.objectContaining({ path: "D:\\project\\config.ts", newText: "a\nb" })]);
  });

  it("keeps the first file baseline across sequential tool edits", () => {
    let state = applySessionUpdate(createEmptySessionView(), {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      content: [{
        type: "diff",
        path: "D:\\project\\config.ts",
        oldText: "const mode = 'safe';",
        newText: "const mode = 'balanced';",
      }],
    }, "2026-07-14T03:00:00.000Z");
    state = applySessionUpdate(state, {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-2",
      content: [{
        type: "diff",
        path: "D:\\project\\config.ts",
        oldText: "const mode = 'balanced';",
        newText: "const mode = 'fast';",
      }],
    }, "2026-07-14T03:01:00.000Z");

    expect(state.changes).toEqual([expect.objectContaining({
      path: "D:\\project\\config.ts",
      oldText: "const mode = 'safe';",
      newText: "const mode = 'fast';",
      toolCallId: "tool-2",
    })]);
  });

  it("removes a cumulative change when a later edit restores the baseline", () => {
    let state = applySessionUpdate(createEmptySessionView(), {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      content: [{ type: "diff", path: "D:\\project\\config.ts", oldText: "safe", newText: "fast" }],
    }, now);
    state = applySessionUpdate(state, {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-2",
      content: [{ type: "diff", path: "D:\\project\\config.ts", oldText: "fast", newText: "safe" }],
    }, now);

    expect(state.changes).toEqual([]);
  });

  it("removes a newly created file after a later tool deletes it", () => {
    let state = applySessionUpdate(createEmptySessionView(), {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-create",
      content: [{ type: "diff", path: "D:\\project\\new.ts", newText: "export {};" }],
    }, now);
    state = applySessionUpdate(state, {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-delete",
      content: [{ type: "diff", path: "D:\\project\\new.ts", oldText: "export {};", newText: "" }],
    }, now);

    expect(state.changes).toEqual([]);
  });

  it("tracks plan and mode updates while preserving unknown protocol data", () => {
    let state = applySessionUpdate(createEmptySessionView(), {
      sessionUpdate: "plan",
      entries: [{ content: "检查入口", priority: "high", status: "in_progress" }],
    }, now);
    state = applySessionUpdate(state, { sessionUpdate: "current_mode_update", currentModeId: "code" }, now);
    state = applySessionUpdate(state, { sessionUpdate: "future_update", payload: { value: 1 } }, now);

    expect(state.plan[0]).toMatchObject({ content: "检查入口", status: "in_progress" });
    expect(state.currentModeId).toBe("code");
    expect(state.activity.at(-1)).toMatchObject({ type: "future_update", unknown: true, raw: { sessionUpdate: "future_update", payload: { value: 1 } } });
  });

  it("keeps plan timeline snapshots scoped to the turn that published them", () => {
    let state = addLocalPrompt(createEmptySessionView(), "先检查入口", "2026-07-13T12:00:00.000Z");
    state = applySessionUpdate(state, {
      sessionUpdate: "plan",
      entries: [{ content: "检查入口", priority: "high", status: "in_progress" }],
    }, "2026-07-13T12:00:01.000Z");
    state = applySessionUpdate(state, {
      sessionUpdate: "plan",
      entries: [{ content: "检查入口", priority: "high", status: "completed" }],
    }, "2026-07-13T12:00:02.000Z");
    state = addLocalPrompt(state, "再检查测试", "2026-07-13T12:01:00.000Z");
    state = applySessionUpdate(state, {
      sessionUpdate: "plan",
      entries: [{ content: "运行测试", priority: "medium", status: "in_progress" }],
    }, "2026-07-13T12:01:01.000Z");

    const plans = state.timeline.filter((item) => item.kind === "plan");
    expect(plans).toHaveLength(2);
    expect(plans[0]).toMatchObject({
      planId: null,
      entries: [{ content: "检查入口", status: "completed" }],
    });
    expect(plans[1]).toMatchObject({
      planId: null,
      entries: [{ content: "运行测试", status: "in_progress" }],
    });
    expect(state.plan).toEqual([expect.objectContaining({ content: "运行测试" })]);
  });

  it("tracks unstable plan ids and ignores removal of a stale plan", () => {
    let state = applySessionUpdate(createEmptySessionView(), {
      sessionUpdate: "plan_update",
      plan: {
        type: "items",
        planId: "plan-a",
        entries: [{ content: "旧计划", priority: "medium", status: "pending" }],
      },
    }, "2026-07-13T12:00:00.000Z");
    state = applySessionUpdate(state, {
      sessionUpdate: "plan_update",
      plan: { type: "markdown", planId: "plan-b", content: "## 新计划" },
    }, "2026-07-13T12:00:01.000Z");
    state = applySessionUpdate(state, {
      sessionUpdate: "plan_update",
      plan: {
        type: "items",
        planId: "plan-b",
        entries: [{ content: "新计划步骤", priority: "high", status: "in_progress" }],
      },
    }, "2026-07-13T12:00:01.500Z");
    state = applySessionUpdate(state, {
      sessionUpdate: "plan_update",
      plan: { type: "markdown", planId: "plan-b", content: "## 新计划" },
    }, "2026-07-13T12:00:01.750Z");
    state = applySessionUpdate(state, {
      sessionUpdate: "plan_removed",
      planId: "plan-a",
    }, "2026-07-13T12:00:02.000Z");

    expect(state.activePlanId).toBe("plan-b");
    expect(state.plan).toEqual([]);
    expect(state.planNote).toBe("## 新计划");
    expect(state.timeline.filter((item) => item.kind === "plan")).toEqual([
      expect.objectContaining({ planId: "plan-b", entries: [], note: "## 新计划" }),
    ]);

    state = applySessionUpdate(state, {
      sessionUpdate: "plan_removed",
      planId: "plan-b",
    }, "2026-07-13T12:00:03.000Z");
    expect(state.activePlanId).toBeNull();
    expect(state.planNote).toBeNull();
    expect(state.timeline.filter((item) => item.kind === "plan")).toEqual([]);
  });

  it("hydrates normalized session configuration and commands from session-ready", () => {
    const state = applySessionReady(createEmptySessionView(), {
      sessionId: "session-1",
      workspacePath: "D:\\project",
      title: "Review",
      currentModeId: "code",
      availableModes: [],
      configOptions: [{
        id: "model",
        name: "Model",
        type: "select",
        currentValue: "grok-build",
        readOnly: true,
        category: "model",
        options: [{ value: "grok-build", name: "Grok Build" }],
      }],
      availableCommands: [{
        name: "review",
        description: "Review the current changes",
        inputHint: "optional scope",
      }],
      loaded: false,
    });

    expect(state.currentModeId).toBe("code");
    expect(state.configOptions).toEqual([expect.objectContaining({ id: "model", readOnly: true })]);
    expect(state.availableCommands).toEqual([{
      name: "review",
      description: "Review the current changes",
      inputHint: "optional scope",
    }]);
  });

  it("marks replayed history complete when a stored session finishes loading", () => {
    const replayed = applySessionUpdate(createEmptySessionView(), {
      sessionUpdate: "agent_message_chunk",
      messageId: "history-answer",
      content: { type: "text", text: "历史回答" },
    }, now);
    const state = applySessionReady(replayed, {
      sessionId: "session-history",
      workspacePath: "D:\\project",
      title: "History",
      currentModeId: null,
      availableModes: [],
      configOptions: [],
      availableCommands: [],
      loaded: true,
    });

    expect(state.timeline[0]).toMatchObject({
      kind: "message",
      text: "历史回答",
      streaming: false,
    });
  });

  it("projects dynamic capabilities through renderer-safe fields", () => {
    let state = applySessionUpdate(createEmptySessionView(), {
      sessionUpdate: "config_option_update",
      configOptions: [
        {
          id: "reasoning",
          name: "Reasoning",
          type: "select",
          currentValue: "balanced",
          readOnly: false,
          options: [{ value: "balanced", name: "Balanced", _meta: { secret: true } }],
          _meta: { secret: true },
        },
        {
          id: "model",
          name: "Model",
          type: "select",
          currentValue: "grok-build",
          options: [{ value: "grok-build", name: "Grok Build" }],
        },
      ],
    }, now);
    state = applySessionUpdate(state, {
      sessionUpdate: "available_commands_update",
      availableCommands: [
        {
          name: "review",
          description: "Review the current changes",
          input: { hint: "optional scope" },
          _meta: { path: "C:\\private\\command.md" },
        },
        { name: "review", description: "duplicate" },
      ],
    }, now);

    expect(state.configOptions).toEqual([
      expect.objectContaining({ id: "reasoning", readOnly: false }),
      expect.objectContaining({ id: "model", readOnly: true }),
    ]);
    expect(state.availableCommands).toEqual([{
      name: "review",
      description: "Review the current changes",
      inputHint: "optional scope",
    }]);
    expect(JSON.stringify({
      configOptions: state.configOptions,
      availableCommands: state.availableCommands,
    })).not.toContain("private");
  });

  it("marks streamed messages complete at turn end", () => {
    const state = applySessionUpdate(createEmptySessionView(), {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "完成" },
    }, now);
    const finished = finishTurn(state, "end_turn");
    expect(finished.timeline[0]).toMatchObject({ streaming: false });
    expect(finished.stopReason).toBe("end_turn");
    expect(finished.turnOutcome).toBe("end_turn");
  });

  it("merges standard context usage with prompt-response token totals", () => {
    let state = applySessionUpdate(createEmptySessionView(), {
      sessionUpdate: "usage_update",
      used: 12_500,
      size: 100_000,
      cost: { amount: 0.42, currency: "usd" },
    }, now);
    state = applySessionUpdate(state, {
      sessionUpdate: "usage_update",
      usage: {
        totalTokens: 13_200,
        inputTokens: 12_000,
        outputTokens: 1_000,
        thoughtTokens: 200,
      },
    }, now);

    expect(state.usage).toEqual({
      contextUsed: 12_500,
      contextSize: 100_000,
      totalTokens: 13_200,
      inputTokens: 12_000,
      outputTokens: 1_000,
      thoughtTokens: 200,
      cost: { amount: 0.42, currency: "USD" },
    });
  });

  it("clears nullable thought usage and rejects invalid token counts", () => {
    let state = applySessionUpdate(createEmptySessionView(), {
      sessionUpdate: "usage_update",
      used: 12_500,
      size: 100_000,
      usage: {
        totalTokens: 13_200,
        inputTokens: 12_000,
        outputTokens: 1_000,
        thoughtTokens: 200,
      },
    }, now);
    state = applySessionUpdate(state, {
      sessionUpdate: "usage_update",
      used: 12_500.5,
      size: Number.POSITIVE_INFINITY,
      usage: {
        totalTokens: 13_200.5,
        inputTokens: -1,
        outputTokens: Number.NaN,
        thoughtTokens: null,
      },
    }, now);

    expect(state.usage).toMatchObject({
      contextUsed: 12_500,
      contextSize: 100_000,
      totalTokens: 13_200,
      inputTokens: 12_000,
      outputTokens: 1_000,
      thoughtTokens: null,
    });
  });

  it("coalesces streaming activity and updates one tool record in place", () => {
    let state = applySessionUpdate(createEmptySessionView(), {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "先检查" },
    }, now);
    state = applySessionUpdate(state, {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "入口文件" },
    }, now);
    state = applySessionUpdate(state, {
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "读取入口",
      kind: "read",
      status: "in_progress",
    }, now);
    state = applySessionUpdate(state, {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      status: "completed",
    }, now);

    expect(state.activity).toHaveLength(2);
    expect(state.activity[0]).toMatchObject({
      type: "agent_thought_chunk",
      detail: "先检查入口文件",
    });
    expect(state.activity[1]).toMatchObject({
      label: "读取入口",
      detail: "read",
      status: "completed",
    });

    expect(projectVisibleActivity(state.activity)).toMatchObject({
      hiddenCount: 1,
      visible: [expect.objectContaining({ label: "读取入口", status: "completed" })],
    });
  });

  it("hides protocol synchronization noise but preserves unknown and failed activity", () => {
    const records = [
      { id: "commands", type: "available_commands_update", label: "命令", detail: "34", receivedAt: now, raw: {}, unknown: false },
      { id: "usage", type: "usage_update", label: "用量", detail: "10%", receivedAt: now, raw: {}, unknown: false },
      { id: "mode", type: "current_mode_update", label: "模式", detail: "plan", receivedAt: now, raw: {}, unknown: false },
      { id: "failed", type: "tool_call", label: "构建", detail: "execute", status: "failed" as const, receivedAt: now, raw: {}, unknown: false },
      { id: "future", type: "future_update", label: "未来事件", detail: "诊断", receivedAt: now, raw: {}, unknown: true },
    ];

    const projection = projectVisibleActivity(records);
    expect(projection.hiddenCount).toBe(2);
    expect(projection.visible.map((record) => record.id)).toEqual(["mode", "failed", "future"]);
  });

  it("projects replacement lines as a real diff and counts both sides", () => {
    const diff = createLineDiff({
      path: "config.ts",
      oldText: "const mode = 'safe';\nkeep();",
      newText: "const mode = 'fast';\nkeep();",
      toolCallId: "tool-2",
      receivedAt: now,
    });
    expect(diff).toEqual([
      { kind: "removed", text: "const mode = 'safe';", oldLine: 1, newLine: null },
      { kind: "added", text: "const mode = 'fast';", oldLine: null, newLine: 1 },
      { kind: "context", text: "keep();", oldLine: 2, newLine: 2 },
    ]);
    expect(lineStats({
      path: "config.ts",
      oldText: "const mode = 'safe';\nkeep();",
      newText: "const mode = 'fast';\nkeep();",
      toolCallId: "tool-2",
      receivedAt: now,
    })).toEqual({ added: 1, removed: 1 });
  });

  it("keeps a late-file edit visible by projecting compact diff hunks", () => {
    const oldLines = Array.from({ length: 1_000 }, (_, index) => `line ${index + 1}`);
    const newLines = [...oldLines];
    newLines[899] = "line 900 changed";

    const diff = createLineDiff({
      path: "late-change.ts",
      oldText: oldLines.join("\n"),
      newText: newLines.join("\n"),
      toolCallId: "tool-late",
      receivedAt: now,
    });
    const hunks = createDiffHunks(diff);

    expect(lineStatsFromDiff(diff)).toEqual({ added: 1, removed: 1 });
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({
      oldStart: 897,
      oldCount: 7,
      newStart: 897,
      newCount: 7,
      omittedBefore: 896,
      omittedAfter: 97,
    });
    expect(hunks[0]?.lines).toEqual(expect.arrayContaining([
      { kind: "removed", text: "line 900", oldLine: 900, newLine: null },
      { kind: "added", text: "line 900 changed", oldLine: null, newLine: 900 },
    ]));
  });

  it("creates separate hunks for distant edits without dropping either change", () => {
    const oldLines = Array.from({ length: 120 }, (_, index) => `line ${index + 1}`);
    const newLines = [...oldLines];
    newLines[9] = "line 10 changed";
    newLines[109] = "line 110 changed";

    const hunks = createDiffHunks(createLineDiff({
      path: "multi-hunk.ts",
      oldText: oldLines.join("\n"),
      newText: newLines.join("\n"),
      toolCallId: "tool-multi",
      receivedAt: now,
    }));

    expect(hunks).toHaveLength(2);
    expect(hunks.flatMap((hunk) => hunk.lines).filter((line) => line.kind !== "context"))
      .toHaveLength(4);
    expect(hunks[0]?.lines.some((line) => line.oldLine === 10 || line.newLine === 10)).toBe(true);
    expect(hunks[1]?.lines.some((line) => line.oldLine === 110 || line.newLine === 110)).toBe(true);
  });

  it("trims a large shared prefix and suffix before applying the diff size guard", () => {
    const oldLines = Array.from({ length: 3_000 }, (_, index) => `line ${index + 1}`);
    const newLines = [...oldLines];
    newLines[2_499] = "line 2500 changed";

    const diff = createLineDiff({
      path: "large-file.ts",
      oldText: oldLines.join("\n"),
      newText: newLines.join("\n"),
      toolCallId: "tool-large",
      receivedAt: now,
    });

    expect(lineStatsFromDiff(diff)).toEqual({ added: 1, removed: 1 });
    expect(diff.filter((line) => line.kind === "context")).toHaveLength(2_999);
  });

  it("rejects invalid hunk context sizes", () => {
    expect(() => createDiffHunks([], -1)).toThrow("non-negative safe integer");
  });

  it("redacts secrets and bounds raw permission details before rendering", () => {
    const details = summarizePermissionDetails({
      locations: [{ path: "D:\\project\\src\\main.ts", line: 12 }],
      rawInput: {
        command: "curl -H Authorization:Bearer abcdefgh123456 --api-key xai-secret-value https://example.com",
        env: { XAI_API_KEY: "another-secret" },
        password: "plain-password",
      },
    });

    expect(details).toContain("D:\\\\project\\\\src\\\\main.ts");
    expect(details).toContain("[已隐藏]");
    expect(details).not.toContain("abcdefgh123456");
    expect(details).not.toContain("xai-secret-value");
    expect(details).not.toContain("another-secret");
    expect(details).not.toContain("plain-password");
    expect(details.length).toBeLessThanOrEqual(12_000);
    expect(redactPermissionText(`token=${"a".repeat(3_000)}`).length).toBeLessThanOrEqual(2_048);
  });
});
