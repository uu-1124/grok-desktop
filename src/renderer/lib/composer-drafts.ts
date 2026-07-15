export type ComposerDrafts = Record<string, string>;

export function composerDraftKey(
  sessionId: string | null | undefined,
  workspacePath: string | null | undefined,
): string {
  return sessionId ? `session:${sessionId}` : `workspace:${workspacePath ?? ""}`;
}

export function readComposerDraft(drafts: ComposerDrafts, key: string): string {
  return drafts[key] ?? "";
}

export function writeComposerDraft(
  drafts: ComposerDrafts,
  key: string,
  value: string,
): ComposerDrafts {
  if (readComposerDraft(drafts, key) === value) return drafts;
  const next = { ...drafts };
  if (value) next[key] = value;
  else delete next[key];
  return next;
}

export function moveComposerDraft(
  drafts: ComposerDrafts,
  fromKey: string,
  toKey: string,
): ComposerDrafts {
  if (fromKey === toKey || !drafts[fromKey]) return drafts;
  const next = { ...drafts, [toKey]: drafts[fromKey]! };
  delete next[fromKey];
  return next;
}
