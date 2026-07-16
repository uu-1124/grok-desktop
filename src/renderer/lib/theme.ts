import type { ThemePreference } from "../../shared/contracts";

export type ResolvedTheme = "light" | "dark";

export function resolveTheme(
  preference: ThemePreference,
  systemUsesDarkColors: boolean,
): ResolvedTheme {
  return preference === "system"
    ? systemUsesDarkColors ? "dark" : "light"
    : preference;
}
