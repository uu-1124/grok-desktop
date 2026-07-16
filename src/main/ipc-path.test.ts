import { describe, expect, it } from "vitest";

import {
  connectSchema,
  discoverModelsSchema,
  droppedFilesSchema,
  identifierSchema,
  IPC_CHANNELS,
  pathSchema,
  permissionModeSchema,
  themePreferenceSchema,
} from "./ipc";

describe("IPC path boundary", () => {
  it("validates non-empty paths without rewriting significant whitespace", () => {
    expect(pathSchema.parse("/project ")).toBe("/project ");
    expect(pathSchema.parse(" C:\\project")).toBe(" C:\\project");
  });

  it("rejects empty and null-containing paths", () => {
    expect(() => pathSchema.parse("   ")).toThrow();
    expect(() => pathSchema.parse("C:\\project\0child")).toThrow();
  });
});

describe("recent session removal IPC boundary", () => {
  it("uses a dedicated channel and rejects empty or oversized identifiers", () => {
    expect(IPC_CHANNELS.removeRecentSession).toBe("grok-desktop:remove-recent-session");
    expect(identifierSchema.parse(" session-1 ")).toBe("session-1");
    expect(() => identifierSchema.parse("   ")).toThrow();
    expect(() => identifierSchema.parse("x".repeat(1_025))).toThrow();
  });
});

describe("permission mode IPC boundary", () => {
  it("uses a dedicated typed channel and rejects modes Grok does not advertise", () => {
    expect(IPC_CHANNELS.setPermissionMode).toBe("grok-desktop:set-permission-mode");
    expect(permissionModeSchema.parse("auto")).toBe("auto");
    expect(() => permissionModeSchema.parse("bypassPermissions")).toThrow();
    expect(() => permissionModeSchema.parse("unknown")).toThrow();
  });
});

describe("dropped file IPC boundary", () => {
  it("uses a dedicated channel and validates bounded workspace file lists", () => {
    expect(IPC_CHANNELS.resolveDroppedFiles).toBe("grok-desktop:resolve-dropped-files");
    expect(droppedFilesSchema.parse({
      workspacePath: "D:\\project",
      filePaths: ["D:\\project\\image.png"],
    })).toEqual({
      workspacePath: "D:\\project",
      filePaths: ["D:\\project\\image.png"],
    });
    expect(() => droppedFilesSchema.parse({
      workspacePath: "D:\\project",
      filePaths: [],
    })).toThrow();
  });
});

describe("theme preference IPC boundary", () => {
  it("uses a dedicated typed channel and rejects unknown themes", () => {
    expect(IPC_CHANNELS.setThemePreference).toBe("grok-desktop:set-theme-preference");
    expect(themePreferenceSchema.parse("system")).toBe("system");
    expect(themePreferenceSchema.parse("dark")).toBe("dark");
    expect(() => themePreferenceSchema.parse("contrast")).toThrow();
  });
});

describe("explicit xAI connection IPC boundary", () => {
  const validConnection = {
    workspacePath: "D:\\project",
    xaiApiBaseUrl: "https://gateway.example.com/v1",
    xaiApiKey: "test-key",
  };

  it("exposes a dedicated model discovery channel", () => {
    expect(IPC_CHANNELS.discoverModels).toBe("grok-desktop:discover-models");
    expect(discoverModelsSchema.parse(validConnection)).toEqual(validConnection);
  });

  it("rejects connect and discovery calls missing either explicit credential field", () => {
    const { xaiApiKey: _key, ...withoutKey } = validConnection;
    const { xaiApiBaseUrl: _url, ...withoutUrl } = validConnection;

    expect(() => connectSchema.parse(withoutKey)).toThrow();
    expect(() => connectSchema.parse(withoutUrl)).toThrow();
    expect(() => discoverModelsSchema.parse(withoutKey)).toThrow();
    expect(() => discoverModelsSchema.parse(withoutUrl)).toThrow();
  });

  it("accepts a stored credential selector but never both credential sources", () => {
    const storedConnection = {
      workspacePath: "D:\\project",
      xaiApiBaseUrl: "https://gateway.example.com/v1",
      useStoredXaiApiKey: true as const,
    };
    expect(connectSchema.parse(storedConnection)).toEqual(storedConnection);
    expect(discoverModelsSchema.parse(storedConnection)).toEqual(storedConnection);
    expect(() => connectSchema.parse({
      ...validConnection,
      useStoredXaiApiKey: true,
    })).toThrow();
    expect(() => discoverModelsSchema.parse({
      ...validConnection,
      useStoredXaiApiKey: true,
    })).toThrow();
  });

  it("exposes a dedicated channel for deleting only the encrypted local key", () => {
    expect(IPC_CHANNELS.clearStoredXaiApiKey).toBe(
      "grok-desktop:clear-stored-xai-api-key",
    );
  });
});
