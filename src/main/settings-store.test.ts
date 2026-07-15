import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SettingsStore } from "./settings-store";

const temporaryDirectories: string[] = [];

async function createStore(): Promise<{ root: string; store: SettingsStore }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-desktop-settings-"));
  temporaryDirectories.push(root);
  const store = new SettingsStore(root);
  await store.load();
  return { root, store };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("SettingsStore", () => {
  it("persists non-sensitive runtime metadata and replaces duplicate records", async () => {
    const { root, store } = await createStore();
    const workspace = path.join(root, "workspace");
    const executable = path.join(root, "grok.exe");

    await store.setGrokExecutablePath(executable);
    await store.setXaiApiBaseUrl("https://API.EXAMPLE.COM:443/v1");
    await store.recordWorkspace(workspace, "First label");
    await store.recordWorkspace(workspace, "Current label");
    await store.recordSession({
      sessionId: "session-1",
      workspacePath: workspace,
      title: "Initial title",
      createdAt: "2026-07-13T12:00:00.000Z",
      updatedAt: "2026-07-13T12:00:00.000Z",
    });
    await store.recordSession({
      sessionId: "session-1",
      workspacePath: workspace,
      title: "Current title",
      createdAt: "2026-07-13T13:00:00.000Z",
      updatedAt: "2026-07-13T13:00:00.000Z",
    });

    const restored = new SettingsStore(root);
    await restored.load();
    const snapshot = restored.getSnapshot();

    expect(snapshot.grokExecutablePath).toBe(executable);
    expect(snapshot.xaiApiBaseUrl).toBe("https://api.example.com/v1");
    expect(snapshot.permissionMode).toBe("default");
    expect(snapshot.recentWorkspaces).toEqual([
      expect.objectContaining({ path: workspace, label: "Current label" }),
    ]);
    expect(snapshot.recentSessions).toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        title: "Current title",
        createdAt: "2026-07-13T12:00:00.000Z",
        updatedAt: "2026-07-13T13:00:00.000Z",
      }),
    ]);

    const serialized = await readFile(path.join(root, "settings.json"), "utf8");
    expect(serialized).toContain("https://api.example.com/v1");
    expect(serialized).not.toMatch(/token|api[_-]?key|credential/iu);
  });

  it("persists the user-selected Grok permission mode across desktop restarts", async () => {
    const { root, store } = await createStore();

    await store.setPermissionMode("auto");

    const restored = new SettingsStore(root);
    await restored.load();
    expect(restored.getSnapshot().permissionMode).toBe("auto");

    await restored.setPermissionMode("always_approve");
    const unrestricted = new SettingsStore(root);
    await unrestricted.load();
    expect(unrestricted.getSnapshot().permissionMode).toBe("always_approve");

    await unrestricted.setPermissionMode("default");
    const reset = new SettingsStore(root);
    await reset.load();
    expect(reset.getSnapshot().permissionMode).toBe("default");
  });

  it("rejects an unknown permission preference without changing the safe default", async () => {
    const { store } = await createStore();
    await expect(store.setPermissionMode("unknown" as "default")).rejects.toThrow(
      "Invalid permissionMode",
    );
    expect(store.getSnapshot().permissionMode).toBe("default");
  });

  it("preserves significant path whitespace instead of merging distinct workspaces", async () => {
    const { root, store } = await createStore();
    const plainWorkspace = path.join(root, "project");
    const spacedWorkspace = `${plainWorkspace} `;

    await store.recordWorkspace(plainWorkspace, "Plain project");
    await store.recordWorkspace(spacedWorkspace, "Trailing-space project");
    await store.recordSession({
      sessionId: "session-spaced-path",
      workspacePath: spacedWorkspace,
      title: "Spaced path task",
      createdAt: "2026-07-14T12:00:00.000Z",
      updatedAt: "2026-07-14T12:00:00.000Z",
    });

    const restored = new SettingsStore(root);
    await restored.load();
    const snapshot = restored.getSnapshot();

    expect(snapshot.lastWorkspacePath).toBe(spacedWorkspace);
    expect(snapshot.recentWorkspaces.map((entry) => entry.path)).toEqual([
      spacedWorkspace,
      plainWorkspace,
    ]);
    expect(snapshot.recentSessions[0]?.workspacePath).toBe(spacedWorkspace);
  });

  it("falls back to defaults when the local settings document is malformed", async () => {
    const { root } = await createStore();
    await writeFile(path.join(root, "settings.json"), "{not-json", "utf8");

    const restored = new SettingsStore(root);
    await restored.load();

    expect(restored.getSnapshot()).toEqual({
      grokExecutablePath: null,
      xaiApiBaseUrl: null,
      permissionMode: "default",
      lastWorkspacePath: null,
      recentWorkspaces: [],
      recentSessions: [],
    });
  });

  it("commits in-memory settings only after the atomic write succeeds", async () => {
    const { root, store } = await createStore();
    const settingsPath = path.join(root, "settings.json");
    await mkdir(settingsPath);

    await expect(store.setXaiApiBaseUrl("https://gateway.example.com/v1")).rejects.toThrow();
    expect(store.getSnapshot().xaiApiBaseUrl).toBeNull();

    await rm(settingsPath, { recursive: true, force: true });
    await store.setXaiApiBaseUrl("https://gateway.example.com/v1");
    expect(store.getSnapshot().xaiApiBaseUrl).toBe("https://gateway.example.com/v1");
  });

  it("persists an ACP title update without changing the original creation time", async () => {
    const { root, store } = await createStore();
    const workspace = path.join(root, "workspace");
    await store.recordSession({
      sessionId: "session-title",
      workspacePath: workspace,
      title: "Restored Grok task",
      createdAt: "2026-07-13T12:00:00.000Z",
      updatedAt: "2026-07-13T12:00:00.000Z",
    });

    await store.recordSessionTitle(
      "session-title",
      workspace,
      "来自 Grok 的真实标题",
      "2026-07-14T03:30:00.000Z",
    );

    const restored = new SettingsStore(root);
    await restored.load();
    expect(restored.getSnapshot().recentSessions[0]).toMatchObject({
      sessionId: "session-title",
      title: "来自 Grok 的真实标题",
      createdAt: "2026-07-13T12:00:00.000Z",
      updatedAt: "2026-07-14T03:30:00.000Z",
    });
  });

  it("removes only desktop recent metadata and keeps unrelated sessions", async () => {
    const { root, store } = await createStore();
    const workspace = path.join(root, "workspace");
    for (const sessionId of ["session-remove", "session-keep"]) {
      await store.recordSession({
        sessionId,
        workspacePath: workspace,
        title: sessionId,
        createdAt: "2026-07-13T12:00:00.000Z",
        updatedAt: "2026-07-13T12:00:00.000Z",
      });
    }

    const remaining = await store.removeSession("session-remove");
    expect(remaining.map((session) => session.sessionId)).toEqual(["session-keep"]);
    expect(await store.removeSession("session-remove")).toEqual(remaining);

    const restored = new SettingsStore(root);
    await restored.load();
    expect(restored.getSnapshot().recentSessions.map((session) => session.sessionId)).toEqual([
      "session-keep",
    ]);
  });

  it("loads version 1 settings documents that predate the API base URL field", async () => {
    const { root } = await createStore();
    await writeFile(
      path.join(root, "settings.json"),
      JSON.stringify({
        schemaVersion: 1,
        settings: {
          grokExecutablePath: null,
          lastWorkspacePath: null,
          recentWorkspaces: [],
          recentSessions: [],
        },
      }),
      "utf8",
    );

    const restored = new SettingsStore(root);
    await restored.load();

    expect(restored.getSnapshot().xaiApiBaseUrl).toBeNull();
    expect(restored.getSnapshot().permissionMode).toBe("default");
  });

  it("safely falls back to per-operation approval for an unknown stored permission mode", async () => {
    const { root } = await createStore();
    await writeFile(
      path.join(root, "settings.json"),
      JSON.stringify({
        schemaVersion: 1,
        settings: {
          grokExecutablePath: null,
          xaiApiBaseUrl: null,
          permissionMode: "forged-unrestricted-mode",
          lastWorkspacePath: null,
          recentWorkspaces: [],
          recentSessions: [],
        },
      }),
      "utf8",
    );

    const restored = new SettingsStore(root);
    await restored.load();
    expect(restored.getSnapshot().permissionMode).toBe("default");
  });

  it("drops forged API keys and MCP configuration instead of persisting them", async () => {
    const { root } = await createStore();
    await writeFile(
      path.join(root, "settings.json"),
      JSON.stringify({
        schemaVersion: 1,
        settings: {
          grokExecutablePath: null,
          xaiApiBaseUrl: null,
          xaiApiKey: "forged-memory-secret",
          mcpServers: [{
            type: "http",
            name: "Forged tools",
            url: "https://forged-mcp.example.com/",
            headers: [{ name: "Authorization", value: "Bearer forged-memory-secret" }],
          }, {
            type: "stdio",
            name: "Forged local tools",
            command: "C:\\forged\\mcp-server.exe",
            args: ["--token=forged-argument-secret"],
            env: [{ name: "FORGED_TOKEN", value: "forged-environment-secret" }],
          }],
          lastWorkspacePath: null,
          recentWorkspaces: [],
          recentSessions: [],
        },
      }),
      "utf8",
    );

    const restored = new SettingsStore(root);
    await restored.load();
    expect(restored.getSnapshot()).not.toHaveProperty("xaiApiKey");
    expect(restored.getSnapshot()).not.toHaveProperty("mcpServers");

    await restored.setXaiApiBaseUrl("https://api.example.com/v1");
    const serialized = await readFile(path.join(root, "settings.json"), "utf8");
    expect(serialized).not.toContain("forged-memory-secret");
    expect(serialized).not.toContain("forged-mcp.example.com");
    expect(serialized).not.toContain("mcp-server.exe");
    expect(serialized).not.toContain("forged-argument-secret");
    expect(serialized).not.toContain("forged-environment-secret");
    expect(serialized).not.toContain("mcpServers");
    expect(serialized).not.toContain("xaiApiKey");
  });
});
