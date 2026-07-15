import { describe, expect, it } from "vitest";

import {
  readWorkspaceMcpServers,
  workspaceMcpConfigKey,
  writeWorkspaceMcpServers,
  type WorkspaceMcpConfigs,
} from "./workspace-mcp-config";

const projectTools = [{
  type: "http" as const,
  name: "Project tools",
  url: "https://mcp.example.com/api",
  headers: [{ name: "Authorization", value: "Bearer workspace-secret" }],
}];

describe("workspace MCP configuration", () => {
  it("normalizes Windows casing, separators, and trailing slashes", () => {
    expect(workspaceMcpConfigKey("D:/Projects/Grok/", "win32")).toBe("d:\\projects\\grok");
    expect(workspaceMcpConfigKey("d:\\projects\\grok", "win32")).toBe("d:\\projects\\grok");
    expect(workspaceMcpConfigKey("C:\\", "win32")).toBe("c:\\");
    expect(workspaceMcpConfigKey("\\\\server\\share\\", "win32")).toBe("\\\\server\\share");
    expect(workspaceMcpConfigKey("\\\\?\\C:\\", "win32")).toBe("\\\\?\\c:\\");
    expect(workspaceMcpConfigKey(null, "win32")).toBeNull();
  });

  it("preserves POSIX casing and the filesystem root", () => {
    expect(workspaceMcpConfigKey("/Repo/", "linux")).toBe("/Repo");
    expect(workspaceMcpConfigKey("/repo", "linux")).toBe("/repo");
    expect(workspaceMcpConfigKey("/", "linux")).toBe("/");
  });

  it("preserves significant path whitespace instead of merging workspaces", () => {
    expect(workspaceMcpConfigKey("/project", "linux")).toBe("/project");
    expect(workspaceMcpConfigKey("/project ", "linux")).toBe("/project ");
    expect(workspaceMcpConfigKey("\\\\?\\C:\\project", "win32")).toBe("\\\\?\\c:\\project");
    expect(workspaceMcpConfigKey("\\\\?\\C:\\project ", "win32")).toBe("\\\\?\\c:\\project ");
  });

  it("isolates credentials between workspaces and returns defensive copies", () => {
    let configs: WorkspaceMcpConfigs = {};
    configs = writeWorkspaceMcpServers(configs, "D:\\project-a", projectTools, "win32");
    configs = writeWorkspaceMcpServers(configs, "D:\\project-b", [{
      type: "sse",
      name: "Project B events",
      url: "https://events.example.com/mcp",
      headers: [],
    }], "win32");

    const projectA = readWorkspaceMcpServers(configs, "d:/PROJECT-A/", "win32");
    const projectB = readWorkspaceMcpServers(configs, "D:\\project-b", "win32");
    expect(projectA).toEqual(projectTools);
    expect(projectB[0]?.name).toBe("Project B events");
    expect(JSON.stringify(projectB)).not.toContain("workspace-secret");

    expect(projectA[0]?.type).toBe("http");
    if (projectA[0]?.type === "http") {
      projectA[0].headers[0]!.value = "mutated";
    }
    expect(readWorkspaceMcpServers(configs, "D:\\project-a", "win32")).toEqual(projectTools);
  });

  it("migrates an alias to the canonical path only after a successful connection", () => {
    const alias = "D:\\link-to-project";
    const canonical = "D:\\projects\\project-a";
    let configs = writeWorkspaceMcpServers({}, alias, projectTools, "win32");
    configs = writeWorkspaceMcpServers(configs, canonical, projectTools, "win32", alias);

    expect(readWorkspaceMcpServers(configs, alias, "win32")).toEqual([]);
    expect(readWorkspaceMcpServers(configs, canonical, "win32")).toEqual(projectTools);
  });

  it("keeps stdio commands, arguments, and environment isolated in defensive copies", () => {
    const stdio = [{
      type: "stdio" as const,
      name: "Local tools",
      command: "D:\\Tools\\mcp.exe",
      args: ["--workspace", "D:\\project-a"],
      env: [{ name: "MCP_TOKEN", value: "workspace-a-secret" }],
    }];
    const configs = writeWorkspaceMcpServers({}, "D:\\project-a", stdio, "win32");
    const first = readWorkspaceMcpServers(configs, "D:\\project-a", "win32");
    expect(first).toEqual(stdio);
    if (first[0]?.type === "stdio") {
      first[0].args[0] = "mutated";
      first[0].env[0]!.value = "mutated";
    }
    expect(readWorkspaceMcpServers(configs, "D:\\project-a", "win32")).toEqual(stdio);
    expect(readWorkspaceMcpServers(configs, "D:\\project-b", "win32")).toEqual([]);
  });

  it("removes one workspace configuration without changing another", () => {
    let configs = writeWorkspaceMcpServers({}, "D:\\project-a", projectTools, "win32");
    configs = writeWorkspaceMcpServers(configs, "D:\\project-b", projectTools, "win32");
    configs = writeWorkspaceMcpServers(configs, "D:\\project-a", [], "win32");

    expect(readWorkspaceMcpServers(configs, "D:\\project-a", "win32")).toEqual([]);
    expect(readWorkspaceMcpServers(configs, "D:\\project-b", "win32")).toEqual(projectTools);
  });

  it("keeps the previous workspace entry until a successful draft is committed", () => {
    const oldServers = projectTools;
    const draftServers = [{
      type: "http" as const,
      name: "Replacement tools",
      url: "https://replacement.example.com/mcp",
      headers: [],
    }];
    const beforeConnection = writeWorkspaceMcpServers(
      {},
      "D:\\project-b",
      oldServers,
      "win32",
    );

    // A failed connection returns without calling the commit helper.
    expect(readWorkspaceMcpServers(beforeConnection, "D:\\project-b", "win32")).toEqual(oldServers);

    const afterSuccess = writeWorkspaceMcpServers(
      beforeConnection,
      "D:\\project-b",
      draftServers,
      "win32",
    );
    expect(readWorkspaceMcpServers(afterSuccess, "D:\\project-b", "win32")).toEqual(draftServers);
  });

  it("rejects attempts to create an unscoped workspace entry", () => {
    expect(() => writeWorkspaceMcpServers({}, " ", projectTools, "win32")).toThrow(
      "有效的工作区路径",
    );
  });
});
