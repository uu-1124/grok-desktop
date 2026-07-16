import { describe, expect, it } from "vitest";

import { resolveTheme } from "./theme";

describe("theme resolution", () => {
  it("preserves explicit light and dark preferences", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("follows the current system color scheme", () => {
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("system", true)).toBe("dark");
  });
});
