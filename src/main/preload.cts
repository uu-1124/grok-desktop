import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

import type {
  ConnectRequest,
  DesktopApi,
  DesktopEventEnvelope,
  PermissionResponsePayload,
  PromptRequest,
  TerminalResizeRequest,
  TerminalStartRequest,
} from "../shared/contracts.js";

const CHANNELS = {
  bootstrap: "grok-desktop:bootstrap",
  syncRuntime: "grok-desktop:sync-runtime",
  chooseWorkspace: "grok-desktop:choose-workspace",
  chooseContextFiles: "grok-desktop:choose-context-files",
  chooseExecutable: "grok-desktop:choose-executable",
  chooseMcpExecutable: "grok-desktop:choose-mcp-executable",
  setXaiApiBaseUrl: "grok-desktop:set-xai-api-base-url",
  connect: "grok-desktop:connect",
  disconnect: "grok-desktop:disconnect",
  createSession: "grok-desktop:create-session",
  loadSession: "grok-desktop:load-session",
  removeRecentSession: "grok-desktop:remove-recent-session",
  prompt: "grok-desktop:prompt",
  cancel: "grok-desktop:cancel",
  setSessionMode: "grok-desktop:set-session-mode",
  setSessionConfig: "grok-desktop:set-session-config",
  resolvePermission: "grok-desktop:resolve-permission",
  startTerminal: "grok-desktop:start-terminal",
  writeTerminal: "grok-desktop:write-terminal",
  resizeTerminal: "grok-desktop:resize-terminal",
  stopTerminal: "grok-desktop:stop-terminal",
  openInChrome: "grok-desktop:open-in-chrome",
  event: "grok-desktop:event",
} as const;

const api: DesktopApi = Object.freeze({
  bootstrap: () => ipcRenderer.invoke(CHANNELS.bootstrap),
  syncRuntime: (afterSequence?: number) =>
    ipcRenderer.invoke(CHANNELS.syncRuntime, afterSequence),
  chooseWorkspace: () => ipcRenderer.invoke(CHANNELS.chooseWorkspace),
  chooseContextFiles: (workspacePath: string) =>
    ipcRenderer.invoke(CHANNELS.chooseContextFiles, workspacePath),
  chooseExecutable: () => ipcRenderer.invoke(CHANNELS.chooseExecutable),
  chooseMcpExecutable: () => ipcRenderer.invoke(CHANNELS.chooseMcpExecutable),
  setXaiApiBaseUrl: (xaiApiBaseUrl: string | null) =>
    ipcRenderer.invoke(CHANNELS.setXaiApiBaseUrl, xaiApiBaseUrl),
  connect: (request: ConnectRequest) => ipcRenderer.invoke(CHANNELS.connect, request),
  disconnect: () => ipcRenderer.invoke(CHANNELS.disconnect),
  createSession: (title?: string) => ipcRenderer.invoke(CHANNELS.createSession, title),
  loadSession: (sessionId: string) => ipcRenderer.invoke(CHANNELS.loadSession, sessionId),
  removeRecentSession: (sessionId: string) =>
    ipcRenderer.invoke(CHANNELS.removeRecentSession, sessionId),
  prompt: (request: PromptRequest) => ipcRenderer.invoke(CHANNELS.prompt, request),
  cancel: (sessionId: string) => ipcRenderer.invoke(CHANNELS.cancel, sessionId),
  setSessionMode: (sessionId: string, modeId: string) =>
    ipcRenderer.invoke(CHANNELS.setSessionMode, { sessionId, modeId }),
  setSessionConfig: (sessionId: string, configId: string, value: string | boolean) =>
    ipcRenderer.invoke(CHANNELS.setSessionConfig, { sessionId, configId, value }),
  resolvePermission: (response: PermissionResponsePayload) =>
    ipcRenderer.invoke(CHANNELS.resolvePermission, response),
  startTerminal: (request: TerminalStartRequest) =>
    ipcRenderer.invoke(CHANNELS.startTerminal, request),
  writeTerminal: (data: string) => ipcRenderer.invoke(CHANNELS.writeTerminal, data),
  resizeTerminal: (request: TerminalResizeRequest) =>
    ipcRenderer.invoke(CHANNELS.resizeTerminal, request),
  stopTerminal: () => ipcRenderer.invoke(CHANNELS.stopTerminal),
  openInChrome: (url: string) => ipcRenderer.invoke(CHANNELS.openInChrome, url),
  onEvent: (listener: (envelope: DesktopEventEnvelope) => void) => {
    if (typeof listener !== "function") {
      throw new TypeError("Desktop event listener must be a function.");
    }

    // Deliberately omit IpcRendererEvent so the renderer never receives a
    // reference to Electron's event.sender or any IPC primitive.
    const wrapped = (_event: IpcRendererEvent, envelope: DesktopEventEnvelope): void => {
      listener(envelope);
    };
    ipcRenderer.on(CHANNELS.event, wrapped);

    let subscribed = true;
    return () => {
      if (!subscribed) {
        return;
      }
      subscribed = false;
      ipcRenderer.removeListener(CHANNELS.event, wrapped);
    };
  },
});

contextBridge.exposeInMainWorld("grokDesktop", api);
