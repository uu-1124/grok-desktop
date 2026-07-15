import type { McpServerConfig } from "../../shared/contracts";
import { normalizeMcpServers } from "../../shared/mcp-config";

export type WorkspaceMcpConfigs = Record<string, McpServerConfig[]>;

export function workspaceMcpConfigKey(
  workspacePath: string | null | undefined,
  platform: string,
): string | null {
  if (!workspacePath?.trim()) return null;
  const candidate = workspacePath;
  const normalized = platform === "win32"
    ? normalizeWindowsWorkspaceKey(candidate)
    : candidate === "/" ? candidate : candidate.replace(/\/+$/gu, "");
  return normalized || null;
}

export function readWorkspaceMcpServers(
  configs: WorkspaceMcpConfigs,
  workspacePath: string | null | undefined,
  platform: string,
): McpServerConfig[] {
  const key = workspaceMcpConfigKey(workspacePath, platform);
  return key ? cloneMcpServers(configs[key] ?? []) : [];
}

export function writeWorkspaceMcpServers(
  configs: WorkspaceMcpConfigs,
  workspacePath: string,
  servers: readonly McpServerConfig[],
  platform: string,
  previousWorkspacePath?: string | null,
): WorkspaceMcpConfigs {
  const key = workspaceMcpConfigKey(workspacePath, platform);
  if (!key) throw new TypeError("MCP 配置需要有效的工作区路径。");
  const previousKey = workspaceMcpConfigKey(previousWorkspacePath, platform);
  const normalizedServers = normalizeMcpServers(servers);
  const next = { ...configs };
  if (previousKey && previousKey !== key) delete next[previousKey];
  if (normalizedServers.length === 0) delete next[key];
  else next[key] = cloneMcpServers(normalizedServers);
  return next;
}

function normalizeWindowsWorkspaceKey(value: string): string {
  const normalized = value.replace(/\//gu, "\\");
  if (/^[A-Za-z]:\\+$/u.test(normalized)) {
    return `${normalized.slice(0, 2).toLocaleLowerCase("en-US")}\\`;
  }
  if (/^\\\\\?\\[A-Za-z]:\\+$/u.test(normalized)) {
    return `${normalized.slice(0, 6).toLocaleLowerCase("en-US")}\\`;
  }
  return normalized.replace(/\\+$/gu, "").toLocaleLowerCase("en-US");
}

function cloneMcpServers(servers: readonly McpServerConfig[]): McpServerConfig[] {
  return servers.map((server) => server.type === "stdio"
    ? {
        ...server,
        args: [...server.args],
        env: server.env.map((variable) => ({ ...variable })),
      }
    : {
        ...server,
        headers: server.headers.map((header) => ({ ...header })),
      });
}
