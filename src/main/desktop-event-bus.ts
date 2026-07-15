import type {
  DesktopEvent,
  DesktopEventEnvelope,
} from "../shared/contracts.js";

const DEFAULT_MAX_REPLAY_EVENTS = 1_000;
const DEFAULT_MAX_REPLAY_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_EVENT_BYTES = 256 * 1024;

interface ReplayEntry {
  envelope: DesktopEventEnvelope;
  bytes: number;
}

export interface DesktopEventReplay {
  events: DesktopEventEnvelope[];
  latestSequence: number;
  replayTruncated: boolean;
}

export interface DesktopEventBusOptions {
  maxReplayEvents?: number;
  maxReplayBytes?: number;
  maxEventBytes?: number;
}

/**
 * Sequences renderer events and retains a bounded, in-memory replay window.
 * Terminal bytes are deliberately live-only: replaying TUI output can expose
 * secrets and grow without a meaningful product-state boundary.
 */
export class DesktopEventBus {
  readonly #send: (envelope: DesktopEventEnvelope) => void;
  readonly #maxReplayEvents: number;
  readonly #maxReplayBytes: number;
  readonly #maxEventBytes: number;
  #sequence = 0;
  #replayBytes = 0;
  #highestDroppedSequence = 0;
  #entries: ReplayEntry[] = [];

  constructor(
    send: (envelope: DesktopEventEnvelope) => void,
    options: DesktopEventBusOptions = {},
  ) {
    this.#send = send;
    this.#maxReplayEvents = requirePositiveInteger(
      options.maxReplayEvents ?? DEFAULT_MAX_REPLAY_EVENTS,
      "maxReplayEvents",
    );
    this.#maxReplayBytes = requirePositiveInteger(
      options.maxReplayBytes ?? DEFAULT_MAX_REPLAY_BYTES,
      "maxReplayBytes",
    );
    this.#maxEventBytes = requirePositiveInteger(
      options.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES,
      "maxEventBytes",
    );
  }

  emit(event: DesktopEvent): DesktopEventEnvelope {
    const envelope: DesktopEventEnvelope = {
      sequence: ++this.#sequence,
      event: cloneSerializable(event),
    };
    this.#record(envelope);
    try {
      this.#send(cloneSerializable(envelope));
    } catch {
      // Renderer loss must not interrupt the Grok runtime. The replay remains
      // available for the next renderer instance.
    }
    return cloneSerializable(envelope);
  }

  replay(afterSequence = 0): DesktopEventReplay {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new TypeError("afterSequence must be a non-negative safe integer.");
    }
    return {
      events: this.#entries
        .filter((entry) => entry.envelope.sequence > afterSequence)
        .map((entry) => cloneSerializable(entry.envelope)),
      latestSequence: this.#sequence,
      replayTruncated: this.#highestDroppedSequence > afterSequence,
    };
  }

  #record(envelope: DesktopEventEnvelope): void {
    if (envelope.event.type === "terminal-data") {
      return;
    }

    const bytes = serializedSize(envelope);
    if (bytes === null || bytes > this.#maxEventBytes) {
      this.#highestDroppedSequence = envelope.sequence;
      return;
    }

    this.#entries.push({ envelope, bytes });
    this.#replayBytes += bytes;
    while (
      this.#entries.length > this.#maxReplayEvents ||
      this.#replayBytes > this.#maxReplayBytes
    ) {
      const removed = this.#entries.shift();
      if (!removed) {
        break;
      }
      this.#replayBytes -= removed.bytes;
      this.#highestDroppedSequence = Math.max(
        this.#highestDroppedSequence,
        removed.envelope.sequence,
      );
    }
  }
}

function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

function serializedSize(value: unknown): number | null {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return null;
  }
}

function cloneSerializable<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as T;
  }
}
