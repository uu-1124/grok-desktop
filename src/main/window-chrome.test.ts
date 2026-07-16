import { describe, expect, it } from "vitest";

import { windowChromeOptions, windowThemeColors } from "./window-chrome";

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

  it("uses readable native controls and backgrounds for the dark theme", () => {
    expect(windowThemeColors(true)).toEqual({
      backgroundColor: "#0e0f10",
      titleBarOverlay: {
        color: "#111214",
        symbolColor: "#ebe8df",
        height: 58,
      },
    });
    expect(windowChromeOptions("win32", true)).toEqual({
      titleBarStyle: "hidden",
      titleBarOverlay: windowThemeColors(true).titleBarOverlay,
    });
  });
});
