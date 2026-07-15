import { describe, expect, it } from "vitest";
import { userFacingErrorMessage } from "./user-facing-error";

describe("user-facing error normalization", () => {
  it("removes Electron IPC plumbing while preserving the underlying reason", () => {
    expect(userFacingErrorMessage(
      new Error("Error invoking remote method 'grok-desktop:prompt': Error: Prompt rejected by Grok"),
      "消息发送失败",
    )).toBe("Prompt rejected by Grok");
  });

  it("accepts string failures and falls back for empty unknown values", () => {
    expect(userFacingErrorMessage("  connection\nclosed  ", "连接失败")).toBe("connection closed");
    expect(userFacingErrorMessage(null, "连接失败")).toBe("连接失败");
    expect(userFacingErrorMessage(" ", "连接失败")).toBe("连接失败");
  });

  it("bounds unexpectedly large errors before they reach persistent UI", () => {
    const message = userFacingErrorMessage(new Error("x".repeat(500)), "操作失败");
    expect(message).toHaveLength(360);
    expect(message.endsWith("…")).toBe(true);
  });
});
