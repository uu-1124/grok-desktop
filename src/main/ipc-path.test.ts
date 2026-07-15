import { describe, expect, it } from "vitest";

import { identifierSchema, IPC_CHANNELS, pathSchema, permissionModeSchema } from "./ipc";

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
