import { fileURLToPath } from "node:url";

import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeTheme,
  screen,
  session,
  type WebContents,
} from "electron";

import { DesktopEventBus } from "./desktop-event-bus.js";
import { GrokRuntime } from "./grok-runtime.js";
import { IPC_CHANNELS, registerIpcHandlers } from "./ipc.js";
import { SettingsStore } from "./settings-store.js";
import { TerminalManager } from "./terminal-manager.js";
import { calculateInitialWindowSize } from "./window-bounds.js";
import { windowChromeOptions } from "./window-chrome.js";

const WINDOW_TITLE = "Grok Desktop";
const PRODUCTION_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "form-action 'none'",
].join("; ");

let mainWindow: BrowserWindow | null = null;
let runtime: GrokRuntime | null = null;
let terminal: TerminalManager | null = null;
let disposeIpc: (() => void) | null = null;
let shutdownStarted = false;
let shutdownFinished = false;

app.enableSandbox();

const ownsSingleInstanceLock = app.requestSingleInstanceLock();
if (!ownsSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.show();
    mainWindow.focus();
  });

  app.on("before-quit", (event) => {
    if (shutdownFinished) {
      return;
    }

    event.preventDefault();
    if (shutdownStarted) {
      return;
    }
    shutdownStarted = true;

    void shutdown().finally(() => {
      shutdownFinished = true;
      app.quit();
    });
  });

  app.on("window-all-closed", () => {
    app.quit();
  });

  app.on("activate", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
    }
  });

  void app.whenReady().then(initialize).catch((error: unknown) => {
    console.error("Grok Desktop failed to initialize.", safeErrorMessage(error));
    dialog.showErrorBox(WINDOW_TITLE, "桌面端启动失败，请查看日志后重试。");
    app.quit();
  });
}

async function initialize(): Promise<void> {
  app.setAppUserModelId("local.grok.desktop");
  nativeTheme.themeSource = "light";
  Menu.setApplicationMenu(null);
  hardenRendererSessions();

  const settings = new SettingsStore(app.getPath("userData"));
  await settings.load();

  const window = createMainWindow();
  mainWindow = window;

  const eventBus = new DesktopEventBus((envelope): void => {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.event, envelope);
    }
  });

  const grokRuntime = new GrokRuntime((event) => {
    eventBus.emit(event);
    if (
      event.type === "session-update" &&
      event.update.sessionUpdate === "session_info_update" &&
      typeof event.update.title === "string" &&
      event.update.title.trim()
    ) {
      const sessionState = grokRuntime.getSessions().find(
        (session) => session.sessionId === event.sessionId,
      );
      if (sessionState) {
        void settings.recordSessionTitle(
          sessionState.sessionId,
          sessionState.workspacePath,
          sessionState.title,
          event.receivedAt,
        ).catch(() => {
          console.warn("Grok Desktop could not persist updated session metadata.");
        });
      }
    }
  });
  runtime = grokRuntime;
  terminal = new TerminalManager((event) => eventBus.emit(event));
  disposeIpc = registerIpcHandlers({ eventBus, window, runtime, settings, terminal });

  window.once("closed", () => {
    mainWindow = null;
  });

  await loadRenderer(window);
  window.show();
}

function createMainWindow(): BrowserWindow {
  const preloadPath = fileURLToPath(new URL("./preload.cjs", import.meta.url));
  const windowSize = calculateInitialWindowSize(
    screen.getPrimaryDisplay().workAreaSize,
  );
  const window = new BrowserWindow({
    title: WINDOW_TITLE,
    ...windowSize,
    show: false,
    backgroundColor: "#f7f7f5",
    autoHideMenuBar: true,
    ...windowChromeOptions(process.platform),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      navigateOnDragDrop: false,
      devTools: !app.isPackaged,
      spellcheck: true,
    },
  });

  window.webContents.on("render-process-gone", (_event, details) => {
    console.error(`Renderer process exited (${details.reason}).`);
    terminal?.stop();
  });
  window.center();
  return window;
}

function hardenRendererSessions(): void {
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });

  if (app.isPackaged) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": [PRODUCTION_CSP],
        },
      });
    });
  }

  app.on("web-contents-created", (_event, contents) => {
    hardenWebContents(contents);
  });
}

function hardenWebContents(contents: WebContents): void {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event) => {
    event.preventDefault();
  });
  contents.on("will-frame-navigate", (event) => {
    event.preventDefault();
  });
  contents.on("will-redirect", (event) => {
    event.preventDefault();
  });
  contents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });
}

async function loadRenderer(window: BrowserWindow): Promise<void> {
  const developmentUrl = getDevelopmentRendererUrl();
  if (developmentUrl) {
    await window.loadURL(developmentUrl);
    return;
  }

  const rendererPath = fileURLToPath(
    new URL("../../renderer/index.html", import.meta.url),
  );
  await window.loadFile(rendererPath);
}

function getDevelopmentRendererUrl(): string | null {
  if (app.isPackaged || !process.env.VITE_DEV_SERVER_URL) {
    return null;
  }

  try {
    const url = new URL(process.env.VITE_DEV_SERVER_URL);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      url.username ||
      url.password
    ) {
      throw new Error("Untrusted development server URL.");
    }
    return url.toString();
  } catch {
    throw new Error("VITE_DEV_SERVER_URL must be an http://127.0.0.1 URL.");
  }
}

async function shutdown(): Promise<void> {
  disposeIpc?.();
  disposeIpc = null;
  terminal?.stop();
  terminal = null;

  const activeRuntime = runtime;
  runtime = null;
  if (!activeRuntime) {
    return;
  }

  await Promise.race([
    activeRuntime.disconnect().catch((error: unknown) => {
      console.error("Grok runtime cleanup failed.", safeErrorMessage(error));
    }),
    new Promise<void>((resolve) => {
      setTimeout(resolve, 4_000);
    }),
  ]);
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}
