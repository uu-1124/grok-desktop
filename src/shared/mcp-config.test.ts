import { describe, expect, it } from "vitest";

import {
  assertMcpTransportsAdvertised,
  collectMcpHeaderValues,
  collectMcpSensitiveValues,
  getMcpServerCredentialScope,
  isolateMcpStdioEnvironment,
  normalizeMcpServers,
  transitionMcpHeadersForUrl,
} from "./mcp-config";

describe("MCP configuration", () => {
  it("normalizes secure remote and loopback servers", () => {
    expect(normalizeMcpServers([
      {
        type: "http",
        name: "  Project tools  ",
        url: "https://MCP.EXAMPLE.COM:443/api",
        headers: [{ name: " Authorization ", value: " Bearer memory-only " }],
      },
      {
        type: "sse",
        name: "Local events",
        url: "http://127.0.0.1:8787/events",
        headers: [],
      },
    ])).toEqual([
      {
        type: "http",
        name: "Project tools",
        url: "https://mcp.example.com/api",
        headers: [{ name: "Authorization", value: "Bearer memory-only" }],
      },
      {
        type: "sse",
        name: "Local events",
        url: "http://127.0.0.1:8787/events",
        headers: [],
      },
    ]);
  });

  it("rejects credential-bearing URLs, insecure remotes, queries, and unsafe headers", () => {
    const base = { type: "http", name: "Tools", headers: [] } as const;
    expect(() => normalizeMcpServers([{ ...base, url: "https://user:secret@mcp.example.com" }])).toThrow("用户名或密码");
    expect(() => normalizeMcpServers([{ ...base, url: "http://mcp.example.com" }])).toThrow("必须使用 HTTPS");
    expect(() => normalizeMcpServers([{ ...base, url: "https://mcp.example.com?token=secret" }])).toThrow("查询参数");
    expect(() => normalizeMcpServers([{ ...base, url: "https://mcp.example.com", headers: [{ name: "Host", value: "other.example.com" }] }])).toThrow("不受支持");
    expect(() => normalizeMcpServers([{ ...base, url: "https://mcp.example.com", headers: [{ name: "X-Test", value: "a" }, { name: "x-test", value: "b" }] }])).toThrow("重复");
    expect(() => normalizeMcpServers([{ ...base, name: "Tools\nInjected", url: "https://mcp.example.com" }])).toThrow("需要名称");
    expect(() => normalizeMcpServers([{ ...base, url: "https://mcp.example.com", headers: [{ name: "X-Test", value: "中文" }] }])).toThrow("可见 ASCII");
    expect(() => normalizeMcpServers([{ ...base, url: "https://mcp.example.com", headers: [{ name: "Authorization", value: "Bearer abc" }] }])).toThrow("至少 4 个字符");
  });

  it("checks normalized URL length and aggregate Header byte budgets", () => {
    const unicodePath = "测".repeat(700);
    expect(() => normalizeMcpServers([{
      type: "http",
      name: "Expanded URL",
      url: `https://mcp.example.com/${unicodePath}`,
      headers: [],
    }])).toThrow("规范化后");

    const oversizedHeaders = Array.from({ length: 5 }, (_, index) => ({
      name: `X-Token-${index}`,
      value: "a".repeat(14_000),
    }));
    expect(() => normalizeMcpServers([{
      type: "http",
      name: "Oversized headers",
      url: "https://mcp.example.com/",
      headers: oversizedHeaders,
    }])).toThrow("64 KiB");

    const largeButValidHeaders = Array.from({ length: 4 }, (_, index) => ({
      name: `X-Token-${index}`,
      value: "b".repeat(14_000),
    }));
    expect(() => normalizeMcpServers(Array.from({ length: 5 }, (_, index) => ({
      type: "http",
      name: `Server ${index}`,
      url: `https://mcp${index}.example.com/`,
      headers: largeButValidHeaders,
    })))).toThrow("256 KiB");
  });

  it("binds header credentials to an origin and clears them on origin changes", () => {
    const headers = [{ name: "Authorization", value: "Bearer secret" }];
    expect(getMcpServerCredentialScope("https://mcp.example.com/api")).toBe("https://mcp.example.com");
    expect(transitionMcpHeadersForUrl(headers, "https://mcp.example.com", "https://mcp.example.com/v2")).toMatchObject({ headers, cleared: false });
    expect(transitionMcpHeadersForUrl(headers, "https://mcp.example.com", "https://other.example.com/api")).toEqual({
      headers: [],
      headerScope: "https://other.example.com",
      cleared: true,
    });
    expect(transitionMcpHeadersForUrl(headers, "https://mcp.example.com", "https://")).toEqual({
      headers,
      headerScope: "https://mcp.example.com",
      cleared: false,
    });
    expect(transitionMcpHeadersForUrl(headers, undefined, "https://mcp.example.com/api")).toEqual({
      headers: [],
      headerScope: "https://mcp.example.com",
      cleared: true,
    });
  });

  it("collects header values for redaction without exposing names or duplicates", () => {
    expect(collectMcpHeaderValues([{
      type: "http",
      name: "Tools",
      url: "https://mcp.example.com/",
      headers: [
        { name: "Authorization", value: "Bearer secret" },
        { name: "X-Token", value: "Bearer secret" },
      ],
    }])).toEqual(["Bearer secret", "secret"]);
  });

  it("normalizes stdio executable, argument vector, and in-memory environment", () => {
    expect(normalizeMcpServers([{
      type: "stdio",
      name: " Local tools ",
      command: "C:\\Tools\\mcp-server.exe",
      args: ["--project", "D:\\workspace with spaces", ""],
      env: [{ name: " MCP_TOKEN ", value: " memory only " }],
    }])).toEqual([{
      type: "stdio",
      name: "Local tools",
      command: "C:\\Tools\\mcp-server.exe",
      args: ["--project", "D:\\workspace with spaces", ""],
      env: [{ name: "MCP_TOKEN", value: " memory only " }],
    }]);
  });

  it("rejects relative stdio commands, control characters, and duplicate environment names", () => {
    const base = {
      type: "stdio" as const,
      name: "Local tools",
      command: "C:\\Tools\\mcp-server.exe",
      args: [],
      env: [],
    };
    expect(() => normalizeMcpServers([{ ...base, command: "mcp-server.exe" }])).toThrow("绝对可执行文件路径");
    expect(() => normalizeMcpServers([{ ...base, command: "C:\\Tools\\mcp-server.exe " }])).toThrow("绝对可执行文件路径");
    expect(() => normalizeMcpServers([{ ...base, args: ["safe", "bad\nargument"] }])).toThrow("参数无效");
    expect(() => normalizeMcpServers([{
      ...base,
      env: [{ name: "MCP_TOKEN", value: "a" }, { name: "mcp_token", value: "b" }],
    }])).toThrow("无效或重复");
    expect(() => normalizeMcpServers(Array.from({ length: 9 }, (_, index) => ({
      ...base,
      name: `Local tools ${index}`,
    })))).toThrow("stdio 服务器最多");
  });

  it("blanks inherited environment outside a least-privilege allow-list", () => {
    expect(isolateMcpStdioEnvironment(
      [{ name: "PROJECT_TOKEN", value: "explicit-secret" }],
      {
        Path: "C:\\Windows",
        TEMP: "C:\\Temp",
        XAI_API_KEY: "must-not-inherit",
        project_token: "parent-secret",
        DATABASE_URL: "must-not-inherit-either",
        LC_API_KEY: "not-a-locale",
      },
      "win32",
    )).toEqual([
      { name: "PROJECT_TOKEN", value: "explicit-secret" },
      { name: "DATABASE_URL", value: "" },
      { name: "GROK_CODE_XAI_API_KEY", value: "" },
      { name: "LC_API_KEY", value: "" },
      { name: "XAI_API_KEY", value: "" },
    ]);
    expect(isolateMcpStdioEnvironment(
      [],
      { "UNSAFE-NAME": "secret" },
      "win32",
    )).toContainEqual({ name: "UNSAFE-NAME", value: "" });
    expect(() => isolateMcpStdioEnvironment(
      [],
      { "UNSAFE=NAME": "secret" },
      "win32",
    )).toThrow("无法安全覆盖");
  });

  it("collects stdio command, arguments, and explicit environment entries for redaction", () => {
    expect(collectMcpSensitiveValues(normalizeMcpServers([{
      type: "stdio",
      name: "Local tools",
      command: "C:\\Tools\\mcp-server.exe",
      args: ["--token=argument-secret"],
      env: [{ name: "MCP_TOKEN", value: "environment-secret" }],
    }]))).toEqual([
      "Local tools",
      "C:\\Tools\\mcp-server.exe",
      "--token=argument-secret",
      "MCP_TOKEN",
      "environment-secret",
    ]);
  });

  it("rejects transports that the connected Grok did not advertise", () => {
    const server = normalizeMcpServers([{
      type: "sse",
      name: "Events",
      url: "https://mcp.example.com/events",
      headers: [],
    }]);
    expect(() => assertMcpTransportsAdvertised(server, {
      stdio: true,
      http: true,
      sse: false,
      acp: false,
    })).toThrow("未广告 MCP SSE");

    const stdio = normalizeMcpServers([{
      type: "stdio",
      name: "Local tools",
      command: "C:\\Tools\\mcp-server.exe",
      args: [],
      env: [],
    }]);
    expect(() => assertMcpTransportsAdvertised(stdio, {
      stdio: false,
      http: true,
      sse: true,
      acp: false,
    })).toThrow("未广告 MCP STDIO");
  });
});
