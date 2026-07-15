import type { BrowserWindowConstructorOptions } from "electron";

export type WindowChromeOptions = Pick<
  BrowserWindowConstructorOptions,
  "titleBarOverlay" | "titleBarStyle"
>;

const WINDOWS_TITLE_BAR_HEIGHT = 58;

export function windowChromeOptions(platform: NodeJS.Platform): WindowChromeOptions {
  if (platform !== "win32") {
    return {};
  }

  return {
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#fbfbf9",
      symbolColor: "#252521",
      height: WINDOWS_TITLE_BAR_HEIGHT,
    },
  };
}
