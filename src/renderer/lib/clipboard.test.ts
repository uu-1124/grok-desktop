import { describe, expect, it, vi } from "vitest";

import { copyTextToClipboard } from "./clipboard";

describe("renderer clipboard", () => {
  it("copies exact Grok text without transforming Markdown", async () => {
    const writeText = vi.fn(async () => undefined);
    const markdown = "# Result\n\n```ts\nconst source = 'grok';\n```";

    await expect(copyTextToClipboard(markdown, { writeText })).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith(markdown);
  });

  it("fails closed when the clipboard is unavailable or rejects", async () => {
    await expect(copyTextToClipboard("answer", null)).resolves.toBe(false);
    await expect(copyTextToClipboard("answer", {
      writeText: async () => { throw new Error("denied"); },
    })).resolves.toBe(false);
  });

  it("does not write empty response text", async () => {
    const writeText = vi.fn(async () => undefined);
    await expect(copyTextToClipboard("", { writeText })).resolves.toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });
});
