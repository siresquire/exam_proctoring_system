import {
  checkMultiMonitor,
  collectClipboard,
  collectConnection,
  collectContextMenu,
  collectFullscreen,
  collectUnload,
  collectVisibility,
  collectWindowFocus,
  type Detach,
} from "./collectors";
import { createEventQueue, type EventQueue } from "./queue";
import { defaultSeverity } from "./types";
import type {
  ProctorEngine,
  ProctorEngineConfig,
  ProctorEngineEvent,
  ProctorEvent,
  ProctorEventListener,
  ProctorLogResult,
  ProctorSeverity,
  ProctorTerminationListener,
} from "./types";

const DEFAULT_HEARTBEAT_INTERVAL_MS = 20000;

/**
 * Wires collectors -> severity mapping -> listeners + event queue. This is
 * the one function most host apps call; everything else in the package is
 * exported for advanced/standalone use (e.g. the ConsentScreen camera-check
 * uses webcam.ts directly, before a session/engine exists at all).
 *
 * No React import anywhere in this file or its dependencies — start()/
 * stop() is the whole lifecycle contract, so any framework (or none) can
 * drive it from a mount/unmount hook, a Vue composable, etc.
 */
export function createProctorEngine(config: ProctorEngineConfig): ProctorEngine {
  const { sessionId, adapters, options = {} } = config;
  const tier = options.tier ?? 2;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;

  const listeners = new Set<ProctorEventListener>();
  const terminationListeners = new Set<ProctorTerminationListener>();
  let terminated = false;
  let detachers: Detach[] = [];
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  function stopCollectingLocally() {
    // Stops signal capture without touching the queue (the final batch —
    // including the client's own view of what led to termination — should
    // still flush). Used both by the public stop() and by onResult below,
    // which reacts to the server telling us the session is already
    // terminated: continuing to collect after that just wastes cycles.
    if (!running) return;
    running = false;

    for (const detach of detachers) detach();
    detachers = [];

    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  const queue: EventQueue = createEventQueue(sessionId, adapters.transport, {
    batchIntervalMs: options.batchIntervalMs,
    storageKeyPrefix: options.storageKeyPrefix,
    onResult(result: ProctorLogResult) {
      // Fire at most once per session: the server has already appended
      // session_terminated to proctor_events and stopped accepting further
      // logs for this session, so repeated batches settling after
      // termination (in flight, or offline-buffered) must not re-notify.
      if (result.session_status === "terminated" && !terminated) {
        terminated = true;
        stopCollectingLocally();
        for (const listener of terminationListeners) listener(result);
      }
    },
  });

  function report(event: ProctorEvent, severity: ProctorSeverity, meta?: Record<string, unknown>) {
    const payload: ProctorEngineEvent = {
      event_type: event,
      severity,
      occurred_at: new Date().toISOString(),
      meta,
    };
    queue.enqueue(payload);
    for (const listener of listeners) listener(payload);
  }

  function emit(event: ProctorEvent, meta?: Record<string, unknown>) {
    report(event, defaultSeverity(event, tier), meta);
  }

  return {
    start() {
      if (running) return;
      running = true;

      detachers = [
        collectVisibility(emit),
        collectWindowFocus(emit),
        collectFullscreen(emit),
        collectClipboard(emit, { prevent: false }),
        collectContextMenu(emit, { prevent: false }),
        collectConnection(emit),
        collectUnload(emit),
      ];

      void checkMultiMonitor(emit);

      heartbeatTimer = setInterval(() => emit("heartbeat"), heartbeatIntervalMs);

      queue.start();
    },
    stop() {
      stopCollectingLocally();
      queue.stop();
    },
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onTerminated(listener) {
      terminationListeners.add(listener);
      return () => terminationListeners.delete(listener);
    },
    report,
    async flush() {
      await queue.flush();
    },
  };
}
