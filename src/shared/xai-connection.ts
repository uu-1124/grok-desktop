export const MAX_XAI_API_BASE_URL_LENGTH = 2_048;
export const MAX_XAI_API_KEY_LENGTH = 16_384;

export function normalizeXaiApiBaseUrl(
  value: unknown,
): string | null | undefined {
  if (value === undefined || value === null) {
    return value;
  }
  if (typeof value !== "string") {
    throw new TypeError("xaiApiBaseUrl must be a URL string, null, or undefined.");
  }

  const candidate = value.trim();
  if (
    value.length > MAX_XAI_API_BASE_URL_LENGTH ||
    candidate.length === 0 ||
    candidate.includes("\0") ||
    candidate.includes("?") ||
    candidate.includes("#") ||
    hasAuthorityUserInfo(candidate)
  ) {
    throw invalidBaseUrlError();
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw invalidBaseUrlError();
  }

  if (
    !url.hostname ||
    url.username ||
    url.password ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && isLoopbackHostname(url.hostname)))
  ) {
    throw invalidBaseUrlError();
  }

  const normalized = url.toString();
  if (normalized.length > MAX_XAI_API_BASE_URL_LENGTH) {
    throw invalidBaseUrlError();
  }
  return normalized;
}

export function normalizeXaiApiKey(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw invalidApiKeyError();
  }

  const normalized = value.trim();
  if (
    value.length > MAX_XAI_API_KEY_LENGTH ||
    normalized.length === 0 ||
    /[\u0000-\u001F\u007F]/u.test(normalized)
  ) {
    throw invalidApiKeyError();
  }
  return normalized;
}

export function normalizeRequiredXaiConnection(
  baseUrl: unknown,
  apiKey: unknown,
): { xaiApiBaseUrl: string; xaiApiKey: string } {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) {
    throw new TypeError("An explicit xAI API base URL is required.");
  }
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    throw new TypeError("An explicit xAI API key is required.");
  }

  const xaiApiBaseUrl = normalizeXaiApiBaseUrl(baseUrl);
  const xaiApiKey = normalizeXaiApiKey(apiKey);
  if (typeof xaiApiBaseUrl !== "string") {
    throw new TypeError("An explicit xAI API base URL is required.");
  }
  if (typeof xaiApiKey !== "string") {
    throw new TypeError("An explicit xAI API key is required.");
  }
  return { xaiApiBaseUrl, xaiApiKey };
}

export function isLoopbackXaiApiBaseUrl(value: unknown): boolean {
  const normalized = normalizeXaiApiBaseUrl(value);
  return typeof normalized === "string" &&
    isLoopbackHostname(new URL(normalized).hostname);
}

export function xaiApiBaseUrlCandidates(value: unknown): string[] {
  const normalized = normalizeXaiApiBaseUrl(value);
  if (typeof normalized !== "string") {
    throw new TypeError("xaiApiBaseUrl is required for endpoint discovery.");
  }

  const parsed = new URL(normalized);
  const trimmedPath = parsed.pathname.replace(/\/+$/u, "") || "/";
  const exact = new URL(parsed.toString());
  exact.pathname = trimmedPath;
  const exactValue = exact.toString();

  if (trimmedPath === "/") {
    const conventional = new URL(parsed.toString());
    conventional.pathname = "/v1";
    return [conventional.toString(), exactValue];
  }
  if (/\/v\d+(?:\.\d+)?$/iu.test(trimmedPath)) {
    return [exactValue];
  }

  const conventional = new URL(parsed.toString());
  conventional.pathname = `${trimmedPath}/v1`;
  return [exactValue, conventional.toString()];
}

function hasAuthorityUserInfo(value: string): boolean {
  const authorityStart = value.indexOf("//");
  if (authorityStart < 0) {
    return false;
  }
  const authority = value
    .slice(authorityStart + 2)
    .split("/", 1)[0];
  return authority?.includes("@") ?? false;
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLocaleLowerCase("en-US");
  if (
    normalized === "localhost" ||
    normalized === "localhost." ||
    normalized === "[::1]" ||
    normalized === "::1"
  ) {
    return true;
  }

  const octets = normalized.split(".");
  if (octets.length !== 4 || octets.some((octet) => !/^\d{1,3}$/u.test(octet))) {
    return false;
  }
  const numbers = octets.map(Number);
  return numbers[0] === 127 && numbers.every((octet) => octet >= 0 && octet <= 255);
}

function invalidBaseUrlError(): TypeError {
  return new TypeError(
    "xaiApiBaseUrl must be an HTTPS URL, or an HTTP URL on a loopback host, without credentials, query, or fragment.",
  );
}

function invalidApiKeyError(): TypeError {
  return new TypeError(
    `xaiApiKey must be a non-empty string of at most ${MAX_XAI_API_KEY_LENGTH} characters without control characters.`,
  );
}
