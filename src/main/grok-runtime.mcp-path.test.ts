import { beforeEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
  realpath: vi.fn(),
  stat: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    realpath: fsMocks.realpath,
    stat: fsMocks.stat,
  };
});

import { requireMcpExecutablePath } from "./grok-runtime";

describe("MCP stdio executable canonical paths", () => {
  beforeEach(() => {
    fsMocks.realpath.mockReset();
    fsMocks.stat.mockReset();
    fsMocks.stat.mockResolvedValue({
      isDirectory: () => false,
      isFile: () => true,
    });
  });

  it.each([
    "\\\\server\\share\\mcp.exe",
    "\\\\?\\C:\\tools\\mcp.exe",
    "\\\\.\\C:\\tools\\mcp.exe",
  ])("rejects a canonical Windows UNC or device path: %s", async (canonicalPath) => {
    if (process.platform !== "win32") {
      return;
    }

    fsMocks.realpath.mockResolvedValue(canonicalPath);

    await expect(requireMcpExecutablePath("C:\\local-link\\mcp.exe")).rejects.toThrow(
      "本机磁盘",
    );
  });
});
