import { describe, expect, it, vi } from "vitest";

import type { DesktopEvent } from "../shared/contracts";
import { DesktopEventBus } from "./desktop-event-bus";

const notice = (message: string): DesktopEvent => ({
  type: "notice",
  level: "info",
  message,
});

describe("DesktopEventBus", () => {
  it("assigns monotonic sequences and returns defensive replay clones", () => {
    const sent: unknown[] = [];
    const bus = new DesktopEventBus((envelope) => sent.push(envelope));

    bus.emit(notice("one"));
    bus.emit(notice("two"));
    const replay = bus.replay();

    expect(replay.latestSequence).toBe(2);
    expect(replay.replayTruncated).toBe(false);
    expect(replay.events.map((entry) => entry.sequence)).toEqual([1, 2]);
    expect(sent).toHaveLength(2);

    replay.events[0]!.sequence = 999;
    expect(bus.replay().events[0]!.sequence).toBe(1);
  });

  it("keeps terminal output live-only without treating it as lost replay state", () => {
    const bus = new DesktopEventBus(() => undefined);
    bus.emit({ type: "terminal-data", data: "sensitive tui bytes" });
    bus.emit(notice("after terminal"));

    const replay = bus.replay();
    expect(replay.latestSequence).toBe(2);
    expect(replay.events.map((entry) => entry.sequence)).toEqual([2]);
    expect(replay.replayTruncated).toBe(false);
  });

  it("reports truncation when count or byte bounds evict product events", () => {
    const bus = new DesktopEventBus(() => undefined, {
      maxReplayEvents: 2,
      maxReplayBytes: 10_000,
      maxEventBytes: 5_000,
    });
    bus.emit(notice("one"));
    bus.emit(notice("two"));
    bus.emit(notice("three"));

    expect(bus.replay(0)).toMatchObject({
      latestSequence: 3,
      replayTruncated: true,
    });
    expect(bus.replay(0).events.map((entry) => entry.sequence)).toEqual([2, 3]);
    expect(bus.replay(1).replayTruncated).toBe(false);
  });

  it("drops an oversized event and surfaces the replay gap", () => {
    const bus = new DesktopEventBus(() => undefined, {
      maxReplayEvents: 10,
      maxReplayBytes: 10_000,
      maxEventBytes: 120,
    });
    bus.emit(notice("x".repeat(500)));
    bus.emit(notice("small"));

    expect(bus.replay()).toMatchObject({ replayTruncated: true });
    expect(bus.replay().events).toHaveLength(1);
    expect(bus.replay().events[0]!.sequence).toBe(2);
  });

  it("retains replay even when the renderer send callback throws", () => {
    const send = vi.fn(() => {
      throw new Error("renderer gone");
    });
    const bus = new DesktopEventBus(send);

    expect(() => bus.emit(notice("recoverable"))).not.toThrow();
    expect(bus.replay().events).toHaveLength(1);
  });

  it("rejects invalid replay cursors and bounds", () => {
    expect(() => new DesktopEventBus(() => undefined, { maxReplayEvents: 0 })).toThrow();
    const bus = new DesktopEventBus(() => undefined);
    expect(() => bus.replay(-1)).toThrow();
    expect(() => bus.replay(Number.MAX_VALUE)).toThrow();
  });
});
