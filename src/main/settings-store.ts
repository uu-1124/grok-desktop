import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  DesktopSettingsSnapshot,
  RecentWorkspace,
  StoredSession,
} from "../shared/contracts.js";
import { normalizeXaiApiBaseUrl } from "../shared/xai-connection.js";

const SETTINGS_SCHEMA_VERSION = 1;
const MAX_RECENT_WORKSPACES = 20;
const MAX_RECENT_SESSIONS = 100;
const MAX_TEXT_LENGTH = 32_767;

interface SettingsDocument {
  schemaVersion: typeof SETTINGS_SCHEMA_VERSION;
  settings: DesktopSettingsSnapshot;
}

const EMPTY_SETTINGS: DesktopSettingsSnapshot = {
  grokExecutablePath: null,
  xaiApiBaseUrl: null,
  lastWorkspacePath: null,
  recentWorkspaces: [],
  recentSessions: [],
};

export class SettingsStore {
  readonly #settingsPath: string;
  #snapshot = cloneSnapshot(EMPTY_SETTINGS);
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(userDataPath: string) {
    this.#settingsPath = path.join(userDataPath, "settings.json");
  }

  async load(): Promise<void> {
    try {
      const serialized = await readFile(this.#settingsPath, "utf8");
      const parsed: unknown = JSON.parse(serialized);
      this.#snapshot = parseSettingsDocument(parsed);
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") {
        this.#snapshot = cloneSnapshot(EMPTY_SETTINGS);
        return;
      }

      // A malformed local preferences file must not prevent the application
      // from starting. Never log its contents because future schema versions
      // may contain data unknown to this build.
      console.warn("Grok Desktop could not load local settings; defaults will be used.");
      this.#snapshot = cloneSnapshot(EMPTY_SETTINGS);
    }
  }

  getSnapshot(): DesktopSettingsSnapshot {
    return cloneSnapshot(this.#snapshot);
  }

  async setGrokExecutablePath(executablePath: string | null): Promise<void> {
    const value = executablePath === null ? null : requirePath(executablePath, "executablePath");
    await this.#mutate((settings) => {
      settings.grokExecutablePath = value;
    });
  }

  async setXaiApiBaseUrl(xaiApiBaseUrl: string | null): Promise<void> {
    const value = normalizeXaiApiBaseUrl(xaiApiBaseUrl) ?? null;
    await this.#mutate((settings) => {
      settings.xaiApiBaseUrl = value;
    });
  }

  async recordWorkspace(workspacePath: string, label?: string): Promise<void> {
    const normalizedPath = requirePath(workspacePath, "workspacePath");
    const normalizedLabel =
      (optionalText(label) ?? path.basename(normalizedPath)) || normalizedPath;
    const now = new Date().toISOString();

    await this.#mutate((settings) => {
      const workspace: RecentWorkspace = {
        path: normalizedPath,
        label: normalizedLabel,
        lastOpenedAt: now,
      };

      settings.lastWorkspacePath = normalizedPath;
      settings.recentWorkspaces = [
        workspace,
        ...settings.recentWorkspaces.filter(
          (entry) => !pathsEqual(entry.path, normalizedPath),
        ),
      ].slice(0, MAX_RECENT_WORKSPACES);
    });
  }

  async recordSession(session: StoredSession): Promise<void> {
    const normalized = parseStoredSession(session);

    await this.#mutate((settings) => {
      const previous = settings.recentSessions.find(
        (entry) => entry.sessionId === normalized.sessionId,
      );
      const next: StoredSession = {
        ...normalized,
        createdAt: previous?.createdAt ?? normalized.createdAt,
      };

      settings.recentSessions = [
        next,
        ...settings.recentSessions.filter((entry) => entry.sessionId !== next.sessionId),
      ].slice(0, MAX_RECENT_SESSIONS);
    });
  }

  async recordSessionTitle(
    sessionId: string,
    workspacePath: string,
    title: string,
    updatedAt: string,
  ): Promise<void> {
    await this.recordSession({
      sessionId,
      workspacePath,
      title,
      createdAt: updatedAt,
      updatedAt,
    });
  }

  async removeSession(sessionId: string): Promise<StoredSession[]> {
    const normalizedSessionId = requireText(sessionId, "sessionId");
    await this.#mutate((settings) => {
      settings.recentSessions = settings.recentSessions.filter(
        (entry) => entry.sessionId !== normalizedSessionId,
      );
    });
    return this.getSnapshot().recentSessions;
  }

  async #mutate(mutator: (settings: DesktopSettingsSnapshot) => void): Promise<void> {
    const write = this.#writeQueue.then(async () => {
      const next = cloneSnapshot(this.#snapshot);
      mutator(next);
      const document: SettingsDocument = {
        schemaVersion: SETTINGS_SCHEMA_VERSION,
        settings: cloneSnapshot(next),
      };
      await this.#writeAtomically(document);
      this.#snapshot = next;
    });
    this.#writeQueue = write.catch(() => undefined);
    await write;
  }

  async #writeAtomically(document: SettingsDocument): Promise<void> {
    const directory = path.dirname(this.#settingsPath);
    const temporaryPath = `${this.#settingsPath}.${process.pid}.${randomUUID()}.tmp`;

    await mkdir(directory, { recursive: true });
    try {
      await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporaryPath, this.#settingsPath);
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}

function parseSettingsDocument(value: unknown): DesktopSettingsSnapshot {
  if (!isRecord(value) || value.schemaVersion !== SETTINGS_SCHEMA_VERSION) {
    throw new Error("Unsupported settings schema.");
  }

  const settings = value.settings;
  if (!isRecord(settings)) {
    throw new Error("Invalid settings document.");
  }

  return {
    grokExecutablePath: nullablePath(settings.grokExecutablePath),
    xaiApiBaseUrl: normalizeStoredXaiApiBaseUrl(settings.xaiApiBaseUrl),
    lastWorkspacePath: nullablePath(settings.lastWorkspacePath),
    recentWorkspaces: Array.isArray(settings.recentWorkspaces)
      ? settings.recentWorkspaces
          .slice(0, MAX_RECENT_WORKSPACES)
          .map(parseRecentWorkspace)
      : [],
    recentSessions: Array.isArray(settings.recentSessions)
      ? settings.recentSessions.slice(0, MAX_RECENT_SESSIONS).map(parseStoredSession)
      : [],
  };
}

function parseRecentWorkspace(value: unknown): RecentWorkspace {
  if (!isRecord(value)) {
    throw new Error("Invalid recent workspace.");
  }

  return {
    path: requirePath(value.path, "workspace.path"),
    label: requireText(value.label, "workspace.label"),
    lastOpenedAt: requireIsoDate(value.lastOpenedAt, "workspace.lastOpenedAt"),
  };
}

function parseStoredSession(value: unknown): StoredSession {
  if (!isRecord(value)) {
    throw new Error("Invalid stored session.");
  }

  return {
    sessionId: requireText(value.sessionId, "sessionId"),
    workspacePath: requirePath(value.workspacePath, "workspacePath"),
    title: requireText(value.title, "title"),
    createdAt: requireIsoDate(value.createdAt, "createdAt"),
    updatedAt: requireIsoDate(value.updatedAt, "updatedAt"),
  };
}

function requireIsoDate(value: unknown, field: string): string {
  const text = requireText(value, field);
  if (!Number.isFinite(Date.parse(text))) {
    throw new Error(`Invalid ${field}.`);
  }
  return text;
}

function nullablePath(value: unknown): string | null {
  return value === null || value === undefined ? null : requirePath(value, "setting path");
}

function normalizeStoredXaiApiBaseUrl(value: unknown): string | null {
  return normalizeXaiApiBaseUrl(value) ?? null;
}

function optionalText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const text = value.trim();
  return text.length > 0 && text.length <= MAX_TEXT_LENGTH ? text : null;
}

function requirePath(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`Invalid ${field}.`);
  }

  if (value.trim().length === 0 || value.length > MAX_TEXT_LENGTH || value.includes("\0")) {
    throw new Error(`Invalid ${field}.`);
  }
  return value;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`Invalid ${field}.`);
  }

  const text = value.trim();
  if (text.length === 0 || text.length > MAX_TEXT_LENGTH || text.includes("\0")) {
    throw new Error(`Invalid ${field}.`);
  }
  return text;
}

function cloneSnapshot(settings: DesktopSettingsSnapshot): DesktopSettingsSnapshot {
  return {
    grokExecutablePath: settings.grokExecutablePath,
    xaiApiBaseUrl: settings.xaiApiBaseUrl,
    lastWorkspacePath: settings.lastWorkspacePath,
    recentWorkspaces: settings.recentWorkspaces.map((entry) => ({ ...entry })),
    recentSessions: settings.recentSessions.map((entry) => ({ ...entry })),
  };
}

function pathsEqual(left: string, right: string): boolean {
  return process.platform === "win32"
    ? path.resolve(left).toLocaleLowerCase("en-US") ===
        path.resolve(right).toLocaleLowerCase("en-US")
    : path.resolve(left) === path.resolve(right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
