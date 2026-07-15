import { describe, expect, it } from "vitest";

import { calculateInitialWindowSize } from "./window-bounds";

describe("initial window sizing", () => {
  it("uses the target Codex-style workbench size on large displays", () => {
    expect(calculateInitialWindowSize({ width: 1_920, height: 1_040 })).toEqual({
      width: 1_440,
      height: 920,
      minWidth: 980,
      minHeight: 680,
    });
  });

  it("fits inside a scaled laptop work area", () => {
    expect(calculateInitialWindowSize({ width: 1_366, height: 728 })).toEqual({
      width: 1_334,
      height: 696,
      minWidth: 980,
      minHeight: 680,
    });
  });

  it("lowers minimum bounds only when the display cannot fit the preferred size", () => {
    expect(calculateInitialWindowSize({ width: 800, height: 600 })).toEqual({
      width: 768,
      height: 568,
      minWidth: 768,
      minHeight: 568,
    });
  });
});
