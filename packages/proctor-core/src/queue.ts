import type { ProctorEventPayload, ProctorLogResult, ProctorTransportAdapter } from "./types";

/**
 * Batches events and flushes them to the transport adapter on an interval,
 * with exponential backoff on failure and a localStorage-backed offline
 * buffer so events survive a refresh mid-exam (PLAN.md Phase 1 exit
 * criterion). Framework-agnostic: no React, no Supabase import — the
 * adapter is injected.
 */

const DEFAULT_BATCH_INTERVAL_MS = 5000;
const MAX_BACKOFF_MS = 60000;
const MIN_BACKOFF_MS = 1000;

function storageKey(prefix: string, sessionId: string) {
  return `${prefix}:queue:${sessionId}`;
}

function readBuffer(key: string): ProctorEventPayload[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeBuffer(key: string, events: ProctorEventPayload[]) {
  if (typeof localStorage === "undefined") return;
  try {
    if (events.length === 0) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, JSON.stringify(events));
    }
  } catch {
    // Quota exceeded or storage disabled — degrade to memory-only, which is
    // still correct for the current tab, just not refresh-durable.
  }
}

export interface EventQueue {
  enqueue(event: ProctorEventPayload): void;
  /** Force an immediate flush attempt, bypassing the interval timer. Resolves once the attempt settles (success or scheduled retry). */
  flush(): Promise<void>;
  start(): void;
  stop(): void;
  /** Current in-memory + persisted pending count. Test/debug hook. */
  pendingCount(): number;
}

export function createEventQueue(
  sessionId: string,
  transport: ProctorTransportAdapter,
  options: {
    batchIntervalMs?: number;
    storageKeyPrefix?: string;
    /** Called with the server's response every time a batch is accepted (Phase 1.5 violation-limit reporting). */
    onResult?: (result: ProctorLogResult) => void;
  } = {},
): EventQueue {
  const batchIntervalMs = options.batchIntervalMs ?? DEFAULT_BATCH_INTERVAL_MS;
  const key = storageKey(options.storageKeyPrefix ?? "proctor-core", sessionId);

  let pending: ProctorEventPayload[] = readBuffer(key);
  let timer: ReturnType<typeof setInterval> | null = null;
  let backoffMs = MIN_BACKOFF_MS;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;

  function persist() {
    writeBuffer(key, pending);
  }

  async function attemptFlush(): Promise<void> {
    if (inFlight || pending.length === 0) return;
    inFlight = true;
    // Snapshot a copy, not just a reference: `pending` is mutated in place
    // by enqueue() (push), so aliasing it here would let events enqueued
    // during the in-flight await silently join "the batch we already sent"
    // and then get dropped by the batch.length slice below.
    const batch = pending.slice();
    try {
      const result = await transport.sendEvents(sessionId, batch);
      // Only drop the events we actually sent — anything enqueued during
      // the await stays queued for the next flush.
      pending = pending.slice(batch.length);
      persist();
      backoffMs = MIN_BACKOFF_MS;
      if (result) options.onResult?.(result);
    } catch {
      // Leave `pending` untouched (still includes `batch`); retry with
      // exponential backoff. Offline buffering already happened via
      // persist() at enqueue time, so a refresh here loses nothing.
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        void attemptFlush();
      }, backoffMs);
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    } finally {
      inFlight = false;
    }
  }

  return {
    enqueue(event) {
      pending.push(event);
      persist();
    },
    async flush() {
      await attemptFlush();
    },
    start() {
      if (timer) return;
      timer = setInterval(() => {
        void attemptFlush();
      }, batchIntervalMs);
      // Attempt an immediate flush on start so refresh-recovered events
      // (from the offline buffer) go out promptly rather than waiting a
      // full interval.
      void attemptFlush();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    },
    pendingCount() {
      return pending.length;
    },
  };
}
