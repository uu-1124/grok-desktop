import type { DesktopApi } from "../shared/contracts";

declare global {
  interface Window {
    grokDesktop: DesktopApi;
  }
}

export {};
