import type {
  BrowserWindowConstructorOptions,
  TitleBarOverlayOptions,
} from "electron";

export type WindowChromeOptions = Pick<
  BrowserWindowConstructorOptions,
  "titleBarOverlay" | "titleBarStyle"
>;

export interface WindowThemeColors {
  backgroundColor: string;
  titleBarOverlay: TitleBarOverlayOptions;
}

const WINDOWS_TITLE_BAR_HEIGHT = 58;

export function windowChromeOptions(
  platform: NodeJS.Platform,
  dark = false,
): WindowChromeOptions {
  if (platform !== "win32") {
    return {};
  }

  return {
    titleBarStyle: "hidden",
    titleBarOverlay: windowThemeColors(dark).titleBarOverlay,
  };
}

export function windowThemeColors(dark: boolean): WindowThemeColors {
  return {
    backgroundColor: dark ? "#0e0f10" : "#f7f7f5",
    titleBarOverlay: {
      color: dark ? "#111214" : "#fbfbf9",
      symbolColor: dark ? "#ebe8df" : "#252521",
      height: WINDOWS_TITLE_BAR_HEIGHT,
    },
  };
}
