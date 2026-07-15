import { describe, expect, it } from "vitest";

import { windowChromeOptions } from "./window-chrome";

describe("window chrome", () => {
  it("uses the native Windows controls inside the light application title bar", () => {
    expect(windowChromeOptions("win32")).toEqual({
      titleBarStyle: "hidden",
      titleBarOverlay: {
        color: "#fbfbf9",
        symbolColor: "#252521",
        height: 58,
      },
    });
  });

  it.each(["darwin", "linux"] as const)("keeps the default %s window chrome", (platform) => {
    expect(windowChromeOptions(platform)).toEqual({});
  });
});
