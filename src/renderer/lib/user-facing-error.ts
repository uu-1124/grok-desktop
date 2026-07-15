const MAX_USER_FACING_ERROR_LENGTH = 360;

export function userFacingErrorMessage(error: unknown, fallback: string): string {
  const raw = error instanceof Error && error.message
    ? error.message
    : typeof error === "string" && error.trim()
      ? error
      : fallback;
  const normalized = raw
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .replace(/^(?:Error:\s*)+/i, "")
    .trim() || fallback;
  return normalized.length > MAX_USER_FACING_ERROR_LENGTH
    ? `${normalized.slice(0, MAX_USER_FACING_ERROR_LENGTH - 1)}…`
    : normalized;
}
