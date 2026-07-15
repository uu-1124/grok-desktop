import { describe, expect, it } from "vitest";

import { acquireWorkspaceConnectionLock } from "./workspace-connection-lock";

describe("workspace connection lock", () => {
  it("serializes connection attempts and makes release idempotent", () => {
    const lock = { current: false };
    const busyStates: boolean[] = [];
    const onBusyChange = (busy: boolean) => busyStates.push(busy);

    const releaseFirst = acquireWorkspaceConnectionLock(lock, onBusyChange);
    expect(releaseFirst).toBeTypeOf("function");
    expect(acquireWorkspaceConnectionLock(lock, onBusyChange)).toBeNull();

    releaseFirst?.();
    const releaseSecond = acquireWorkspaceConnectionLock(lock, onBusyChange);
    expect(releaseSecond).toBeTypeOf("function");

    releaseFirst?.();
    expect(lock.current).toBe(true);
    releaseSecond?.();

    expect(lock.current).toBe(false);
    expect(busyStates).toEqual([true, false, true, false]);
  });
});
