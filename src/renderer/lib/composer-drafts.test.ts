import { describe, expect, it } from "vitest";

import {
  composerDraftKey,
  moveComposerDraft,
  readComposerDraft,
  writeComposerDraft,
} from "./composer-drafts";

describe("composer drafts", () => {
  it("isolates drafts by task and by unassigned workspace", () => {
    const workspaceKey = composerDraftKey(null, "D:\\project");
    const taskKey = composerDraftKey("session-1", "D:\\project");
    let drafts = writeComposerDraft({}, workspaceKey, "new task draft");
    drafts = writeComposerDraft(drafts, taskKey, "existing task draft");

    expect(readComposerDraft(drafts, workspaceKey)).toBe("new task draft");
    expect(readComposerDraft(drafts, taskKey)).toBe("existing task draft");
  });

  it("moves an unassigned draft into a newly created task without persisting it", () => {
    const workspaceKey = composerDraftKey(null, "D:\\project");
    const taskKey = composerDraftKey("session-2", "D:\\project");
    const drafts = moveComposerDraft(
      writeComposerDraft({}, workspaceKey, "review this project"),
      workspaceKey,
      taskKey,
    );

    expect(readComposerDraft(drafts, workspaceKey)).toBe("");
    expect(readComposerDraft(drafts, taskKey)).toBe("review this project");
  });
});
