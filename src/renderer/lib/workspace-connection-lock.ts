export interface WorkspaceConnectionLock {
  current: boolean;
}

export function acquireWorkspaceConnectionLock(
  lock: WorkspaceConnectionLock,
  onBusyChange: (busy: boolean) => void,
): (() => void) | null {
  if (lock.current) return null;

  lock.current = true;
  onBusyChange(true);
  let released = false;

  return () => {
    if (released) return;
    released = true;
    lock.current = false;
    onBusyChange(false);
  };
}
