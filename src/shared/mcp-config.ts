import type {
  McpHttpHeader,
  McpServerConfig,
  McpStdioEnvironmentVariable,
  RuntimeCapabilities,
} from "./contracts.js";
import { isLoopbackHostname } from "./xai-connection.js";

export const MAX_MCP_SERVERS = 16;
export const MAX_MCP_STDIO_SERVERS = 8;
export const MAX_MCP_HEADERS_PER_SERVER = 32;
export const MAX_MCP_SERVER_NAME_LENGTH = 128;
export const MAX_MCP_SERVER_URL_LENGTH = 2_048;
export const MAX_MCP_STDIO_COMMAND_LENGTH = 32_767;
export const MAX_MCP_STDIO_ARGUMENTS_PER_SERVER = 64;
export const MAX_MCP_STDIO_ARGUMENT_LENGTH = 4_096;
export const MAX_MCP_STDIO_ENV_PER_SERVER = 64;
export const MAX_MCP_STDIO_ENV_NAME_LENGTH = 128;
export const MAX_MCP_STDIO_ENV_VALUE_LENGTH = 8_192;
export const MAX_MCP_HEADER_NAME_LENGTH = 128;
export const MAX_MCP_HEADER_VALUE_LENGTH = 16_384;
export const MAX_MCP_SERVER_HEADER_BYTES = 64 * 1_024;
export const MAX_MCP_CONFIG_HEADER_BYTES = 256 * 1_024;
export const MAX_MCP_STDIO_ARGUMENT_BYTES = 16 * 1_024;
export const MAX_MCP_STDIO_ENV_BYTES = 16 * 1_024;
export const MAX_MCP_CONFIG_STDIO_ENV_BYTES = 64 * 1_024;
export const MAX_MCP_INHERITED_ENVIRONMENT_VARIABLES = 512;

const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/u;
const UNSAFE_STDIO_TEXT_PATTERN = /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069\uD800-\uDFFF]/u;
const VISIBLE_ASCII_HEADER_VALUE_PATTERN = /^[\u0020-\u007E]+$/u;
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][0-9A-Za-z_]*$/u;
const AUTHORIZATION_VALUE_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+\s+(.+)$/u;
const MIN_AUTHORIZATION_CREDENTIAL_LENGTH = 4;
const FORBIDDEN_REQUEST_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const WINDOWS_SAFE_INHERITED_ENVIRONMENT = new Set([
  "allusersprofile",
  "appdata",
  "commonprogramfiles",
  "commonprogramfiles(x86)",
  "commonprogramw6432",
  "comspec",
  "homedrive",
  "homepath",
  "localappdata",
  "number_of_processors",
  "os",
  "path",
  "pathext",
  "processor_architecture",
  "processor_identifier",
  "processor_level",
  "processor_revision",
  "programdata",
  "programfiles",
  "programfiles(x86)",
  "programw6432",
  "public",
  "systemdrive",
  "systemroot",
  "temp",
  "tmp",
  "userdomain",
  "userdomain_roamingprofile",
  "username",
  "userprofile",
  "windir",
]);

const POSIX_SAFE_INHERITED_ENVIRONMENT = new Set([
  "home",
  "lang",
  "logname",
  "path",
  "shell",
  "temp",
  "term",
  "tmp",
  "tmpdir",
  "tz",
  "user",
]);
const ALWAYS_ISOLATED_MCP_ENVIRONMENT = ["XAI_API_KEY", "GROK_CODE_XAI_API_KEY"];
const SAFE_LOCALE_ENVIRONMENT = new Set([
  "lc_all",
  "lc_collate",
  "lc_ctype",
  "lc_messages",
  "lc_monetary",
  "lc_numeric",
  "lc_time",
]);

export function normalizeMcpServers(value: unknown): McpServerConfig[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_MCP_SERVERS) {
    throw new TypeError(`MCP 服务器最多可配置 ${MAX_MCP_SERVERS} 个。`);
  }

  const names = new Set<string>();
  let stdioServerCount = 0;
  let totalHeaderBytes = 0;
  let totalStdioEnvironmentBytes = 0;
  return value.map((candidate, index) => {
    const server = asRecord(candidate);
    if (!server) throw new TypeError(`第 ${index + 1} 个 MCP 服务器配置无效。`);

    const type = normalizeTransport(server.type, index);
    const name = normalizeMcpServerName(server.name, index);
    const nameKey = name.toLocaleLowerCase("en-US");
    if (names.has(nameKey)) throw new TypeError(`MCP 服务器名称不能重复：${name}`);
    names.add(nameKey);

    if (type === "stdio") {
      stdioServerCount += 1;
      if (stdioServerCount > MAX_MCP_STDIO_SERVERS) {
        throw new TypeError(`MCP stdio 服务器最多可配置 ${MAX_MCP_STDIO_SERVERS} 个。`);
      }
      const command = normalizeMcpStdioCommand(server.command, index);
      const args = normalizeMcpStdioArguments(server.args, index);
      const env = normalizeMcpStdioEnvironment(server.env, index);
      const environmentBytes = env.reduce(
        (total, variable) => total + utf8ByteLength(variable.name) + utf8ByteLength(variable.value) + 2,
        0,
      );
      if (environmentBytes > MAX_MCP_STDIO_ENV_BYTES) {
        throw new TypeError(
          `第 ${index + 1} 个 MCP 服务器的环境变量总大小不能超过 ${MAX_MCP_STDIO_ENV_BYTES / 1_024} KiB。`,
        );
      }
      totalStdioEnvironmentBytes += environmentBytes;
      if (totalStdioEnvironmentBytes > MAX_MCP_CONFIG_STDIO_ENV_BYTES) {
        throw new TypeError(
          `全部 MCP 环境变量总大小不能超过 ${MAX_MCP_CONFIG_STDIO_ENV_BYTES / 1_024} KiB。`,
        );
      }
      return { type, name, command, args, env };
    }

    const headers = normalizeHeaders(server.headers, index);
    const headerBytes = headers.reduce(
      (total, header) => total + utf8ByteLength(header.name) + utf8ByteLength(header.value) + 4,
      0,
    );
    if (headerBytes > MAX_MCP_SERVER_HEADER_BYTES) {
      throw new TypeError(
        `第 ${index + 1} 个 MCP 服务器的 Header 总大小不能超过 ${MAX_MCP_SERVER_HEADER_BYTES / 1_024} KiB。`,
      );
    }
    totalHeaderBytes += headerBytes;
    if (totalHeaderBytes > MAX_MCP_CONFIG_HEADER_BYTES) {
      throw new TypeError(
        `全部 MCP Header 总大小不能超过 ${MAX_MCP_CONFIG_HEADER_BYTES / 1_024} KiB。`,
      );
    }

    return {
      type,
      name,
      url: normalizeMcpServerUrl(server.url, index),
      headers,
    };
  });
}

export function validateMcpServers(value: unknown): string | null {
  try {
    normalizeMcpServers(value);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "MCP 服务器配置无效。";
  }
}

export function getMcpServerCredentialScope(
  value: string,
): string | undefined {
  try {
    return new URL(normalizeMcpServerUrl(value, 0)).origin;
  } catch {
    return undefined;
  }
}

export function transitionMcpHeadersForUrl(
  headers: readonly McpHttpHeader[],
  headerScope: string | undefined,
  nextUrl: string,
): {
  headers: McpHttpHeader[];
  headerScope: string | undefined;
  cleared: boolean;
} {
  const nextScope = getMcpServerCredentialScope(nextUrl);
  if (nextScope === undefined) {
    return { headers: cloneHeaders(headers), headerScope, cleared: false };
  }
  if (headers.length > 0 && headerScope !== nextScope) {
    return { headers: [], headerScope: nextScope, cleared: true };
  }
  return { headers: cloneHeaders(headers), headerScope: nextScope, cleared: false };
}

export function collectMcpHeaderValues(
  servers: readonly McpServerConfig[],
): string[] {
  const values = new Set<string>();
  for (const server of servers) {
    if (server.type === "stdio") continue;
    for (const header of server.headers) {
      if (header.value) values.add(header.value);
      if (header.name.toLocaleLowerCase("en-US") === "authorization") {
        const credential = authorizationCredential(header.value);
        if (credential) values.add(credential);
      }
    }
  }
  return [...values];
}

export function collectMcpSensitiveValues(
  servers: readonly McpServerConfig[],
): string[] {
  const values = new Set(collectMcpHeaderValues(servers));
  for (const server of servers) {
    if (server.name) values.add(server.name);
    if (server.type === "stdio") {
      if (server.command) values.add(server.command);
      for (const argument of server.args) {
        if (argument) values.add(argument);
      }
      for (const variable of server.env) {
        if (variable.name) values.add(variable.name);
        if (variable.value) values.add(variable.value);
      }
    } else {
      if (server.url) values.add(server.url);
      for (const header of server.headers) {
        if (header.name) values.add(header.name);
      }
    }
  }
  return [...values];
}

export function isolateMcpStdioEnvironment(
  configured: readonly McpStdioEnvironmentVariable[],
  inherited: Readonly<Record<string, string | undefined>>,
  platform: string,
): McpStdioEnvironmentVariable[] {
  const keyFor = (name: string) => platform === "win32"
    ? name.toLocaleLowerCase("en-US")
    : name;
  const seenInheritedNames = new Set<string>();
  const inheritedNames = [...Object.keys(inherited), ...ALWAYS_ISOLATED_MCP_ENVIRONMENT]
    .filter((name) => {
      const key = keyFor(name);
      if (seenInheritedNames.has(key)) return false;
      seenInheritedNames.add(key);
      return true;
    });
  if (inheritedNames.length > MAX_MCP_INHERITED_ENVIRONMENT_VARIABLES) {
    throw new TypeError("父进程环境变量过多，无法安全隔离 stdio MCP。");
  }

  const normalizedConfigured = normalizeMcpStdioEnvironment(configured, 0);
  const configuredNames = new Set(normalizedConfigured.map((variable) => keyFor(variable.name)));
  const namesToBlank = inheritedNames
    .filter((name) => !configuredNames.has(keyFor(name)))
    .filter((name) => !isSafeInheritedEnvironmentName(name, platform))
    .sort((left, right) => left.localeCompare(right, "en-US"));
  if (namesToBlank.some((name) =>
    !name ||
    name.length > MAX_MCP_STDIO_ENV_NAME_LENGTH ||
    name.includes("=") ||
    UNSAFE_STDIO_TEXT_PATTERN.test(name)
  )) {
    throw new TypeError("父进程包含无法安全覆盖的环境变量名称，已拒绝启动 stdio MCP。");
  }
  const blanked = namesToBlank
    .map((name) => ({ name, value: "" }));
  return [
    ...normalizedConfigured.map((variable) => ({ ...variable })),
    ...blanked,
  ];
}

export function assertMcpTransportsAdvertised(
  servers: readonly McpServerConfig[],
  capabilities: RuntimeCapabilities["mcp"],
): void {
  const unsupported = servers.find((server) => capabilities[server.type] !== true);
  if (unsupported) {
    throw new Error(
      `当前 Grok 未广告 MCP ${unsupported.type.toUpperCase()} 传输，无法连接 ${unsupported.name}。`,
    );
  }
}

function normalizeTransport(value: unknown, index: number): McpServerConfig["type"] {
  if (value !== "http" && value !== "sse" && value !== "stdio") {
    throw new TypeError(`第 ${index + 1} 个 MCP 服务器仅支持 STDIO、HTTP 或 SSE。`);
  }
  return value;
}

function normalizeMcpStdioCommand(value: unknown, index: number): string {
  const message = `第 ${index + 1} 个 MCP stdio 服务器需要绝对可执行文件路径。`;
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value !== value.trim() ||
    value.length > MAX_MCP_STDIO_COMMAND_LENGTH ||
    UNSAFE_STDIO_TEXT_PATTERN.test(value) ||
    !isSyntacticallyAbsolutePath(value)
  ) {
    throw new TypeError(message);
  }
  return value;
}

function normalizeMcpStdioArguments(value: unknown, serverIndex: number): string[] {
  if (!Array.isArray(value) || value.length > MAX_MCP_STDIO_ARGUMENTS_PER_SERVER) {
    throw new TypeError(
      `第 ${serverIndex + 1} 个 MCP stdio 服务器最多可配置 ${MAX_MCP_STDIO_ARGUMENTS_PER_SERVER} 个参数。`,
    );
  }
  let totalBytes = 0;
  const args = value.map((argument, argumentIndex) => {
    if (
      typeof argument !== "string" ||
      argument.length > MAX_MCP_STDIO_ARGUMENT_LENGTH ||
      UNSAFE_STDIO_TEXT_PATTERN.test(argument)
    ) {
      throw new TypeError(
        `第 ${serverIndex + 1} 个 MCP stdio 服务器的第 ${argumentIndex + 1} 个参数无效。`,
      );
    }
    totalBytes += utf8ByteLength(argument) + 1;
    return argument;
  });
  if (totalBytes > MAX_MCP_STDIO_ARGUMENT_BYTES) {
    throw new TypeError(
      `第 ${serverIndex + 1} 个 MCP stdio 服务器的参数总大小不能超过 ${MAX_MCP_STDIO_ARGUMENT_BYTES / 1_024} KiB。`,
    );
  }
  return args;
}

function normalizeMcpStdioEnvironment(
  value: unknown,
  serverIndex: number,
): McpStdioEnvironmentVariable[] {
  if (!Array.isArray(value) || value.length > MAX_MCP_STDIO_ENV_PER_SERVER) {
    throw new TypeError(
      `第 ${serverIndex + 1} 个 MCP stdio 服务器最多可配置 ${MAX_MCP_STDIO_ENV_PER_SERVER} 个环境变量。`,
    );
  }

  const names = new Set<string>();
  return value.map((candidate, variableIndex) => {
    const variable = asRecord(candidate);
    if (!variable) throw invalidEnvironmentVariable(serverIndex, variableIndex);
    const name = normalizeRequiredText(
      variable.name,
      MAX_MCP_STDIO_ENV_NAME_LENGTH,
      `第 ${serverIndex + 1} 个 MCP stdio 服务器的第 ${variableIndex + 1} 个环境变量需要名称。`,
    );
    const nameKey = name.toLocaleLowerCase("en-US");
    if (!ENVIRONMENT_NAME_PATTERN.test(name) || names.has(nameKey)) {
      throw new TypeError(`第 ${serverIndex + 1} 个 MCP stdio 服务器的环境变量名称无效或重复。`);
    }
    names.add(nameKey);

    if (
      typeof variable.value !== "string" ||
      variable.value.length > MAX_MCP_STDIO_ENV_VALUE_LENGTH ||
      UNSAFE_STDIO_TEXT_PATTERN.test(variable.value)
    ) {
      throw invalidEnvironmentVariable(serverIndex, variableIndex);
    }
    return { name, value: variable.value };
  });
}

function isSyntacticallyAbsolutePath(value: string): boolean {
  return value.startsWith("/") ||
    /^[A-Za-z]:[\\/]/u.test(value) ||
    /^\\\\[^\\/]+[\\/][^\\/]+/u.test(value);
}

function isSafeInheritedEnvironmentName(name: string, platform: string): boolean {
  const normalized = name.toLocaleLowerCase("en-US");
  if (SAFE_LOCALE_ENVIRONMENT.has(normalized)) return true;
  if (["force_color", "home", "lang", "language", "no_color", "tz"].includes(normalized)) {
    return true;
  }
  return platform === "win32"
    ? WINDOWS_SAFE_INHERITED_ENVIRONMENT.has(normalized)
    : POSIX_SAFE_INHERITED_ENVIRONMENT.has(normalized);
}

function normalizeMcpServerUrl(value: unknown, index: number): string {
  const candidate = normalizeRequiredText(
    value,
    MAX_MCP_SERVER_URL_LENGTH,
    `第 ${index + 1} 个 MCP 服务器需要完整 URL。`,
  );
  if (
    candidate.includes("?") ||
    candidate.includes("#") ||
    CONTROL_CHARACTER_PATTERN.test(candidate)
  ) {
    throw new TypeError(`第 ${index + 1} 个 MCP URL 不能包含查询参数、片段或控制字符。`);
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new TypeError(`第 ${index + 1} 个 MCP 服务器需要完整 URL。`);
  }
  if (!url.hostname || url.username || url.password) {
    throw new TypeError(`第 ${index + 1} 个 MCP URL 不能包含用户名或密码。`);
  }
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && isLoopbackHostname(url.hostname))
  ) {
    throw new TypeError(`第 ${index + 1} 个 MCP 远程地址必须使用 HTTPS；HTTP 仅允许本机回环地址。`);
  }
  const normalizedUrl = url.toString();
  if (normalizedUrl.length > MAX_MCP_SERVER_URL_LENGTH) {
    throw new TypeError(
      `第 ${index + 1} 个 MCP URL 规范化后不能超过 ${MAX_MCP_SERVER_URL_LENGTH} 个字符。`,
    );
  }
  return normalizedUrl;
}

function normalizeHeaders(value: unknown, serverIndex: number): McpHttpHeader[] {
  if (!Array.isArray(value) || value.length > MAX_MCP_HEADERS_PER_SERVER) {
    throw new TypeError(
      `第 ${serverIndex + 1} 个 MCP 服务器最多可配置 ${MAX_MCP_HEADERS_PER_SERVER} 个 Header。`,
    );
  }

  const names = new Set<string>();
  return value.map((candidate, headerIndex) => {
    const header = asRecord(candidate);
    if (!header) throw invalidHeader(serverIndex, headerIndex);
    const name = normalizeRequiredText(
      header.name,
      MAX_MCP_HEADER_NAME_LENGTH,
      `第 ${serverIndex + 1} 个 MCP 服务器的第 ${headerIndex + 1} 个 Header 需要名称。`,
    );
    const nameKey = name.toLocaleLowerCase("en-US");
    if (!HEADER_NAME_PATTERN.test(name) || FORBIDDEN_REQUEST_HEADERS.has(nameKey)) {
      throw new TypeError(`MCP Header 名称不受支持：${name}`);
    }
    if (names.has(nameKey)) throw new TypeError(`同一 MCP 服务器不能重复设置 Header：${name}`);
    names.add(nameKey);

    const headerValue = normalizeRequiredText(
      header.value,
      MAX_MCP_HEADER_VALUE_LENGTH,
      `第 ${serverIndex + 1} 个 MCP 服务器的 Header ${name} 需要值。`,
    );
    if (!VISIBLE_ASCII_HEADER_VALUE_PATTERN.test(headerValue)) {
      throw new TypeError(`MCP Header ${name} 的值只能包含可见 ASCII 字符。`);
    }
    if (nameKey === "authorization") {
      const credential = authorizationCredential(headerValue);
      if (!credential || credential.length < MIN_AUTHORIZATION_CREDENTIAL_LENGTH) {
        throw new TypeError(
          `MCP Header ${name} 需要认证方案和至少 ${MIN_AUTHORIZATION_CREDENTIAL_LENGTH} 个字符的凭据。`,
        );
      }
    }
    return { name, value: headerValue };
  });
}

function normalizeMcpServerName(value: unknown, index: number): string {
  const message = `第 ${index + 1} 个 MCP 服务器需要名称。`;
  const name = normalizeRequiredText(value, MAX_MCP_SERVER_NAME_LENGTH, message).normalize("NFC");
  if (name.length > MAX_MCP_SERVER_NAME_LENGTH || CONTROL_CHARACTER_PATTERN.test(name)) {
    throw new TypeError(message);
  }
  return name;
}

function authorizationCredential(value: string): string | undefined {
  const credential = AUTHORIZATION_VALUE_PATTERN.exec(value)?.[1]?.trim();
  return credential || undefined;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function normalizeRequiredText(
  value: unknown,
  maximum: number,
  message: string,
): string {
  if (typeof value !== "string" || value.length > maximum) throw new TypeError(message);
  const normalized = value.trim();
  if (!normalized) throw new TypeError(message);
  return normalized;
}

function invalidHeader(serverIndex: number, headerIndex: number): TypeError {
  return new TypeError(
    `第 ${serverIndex + 1} 个 MCP 服务器的第 ${headerIndex + 1} 个 Header 无效。`,
  );
}

function invalidEnvironmentVariable(serverIndex: number, variableIndex: number): TypeError {
  return new TypeError(
    `第 ${serverIndex + 1} 个 MCP stdio 服务器的第 ${variableIndex + 1} 个环境变量无效。`,
  );
}

function cloneHeaders(headers: readonly McpHttpHeader[]): McpHttpHeader[] {
  return headers.map((header) => ({ ...header }));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
