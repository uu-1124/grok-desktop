export interface TextClipboard {
  writeText(text: string): Promise<void>;
}

export async function copyTextToClipboard(
  text: string,
  clipboard?: TextClipboard | null,
): Promise<boolean> {
  const target = clipboard === undefined
    ? typeof navigator !== "undefined" && navigator.clipboard
      ? navigator.clipboard
      : null
    : clipboard;
  if (!target || !text) return false;
  try {
    await target.writeText(text);
    return true;
  } catch {
    return false;
  }
}
