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
  ProctorSeverity,
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
  const queue: EventQueue = createEventQueue(sessionId, adapters.transport, {
    batchIntervalMs: options.batchIntervalMs,
    storageKeyPrefix: options.storageKeyPrefix,
  });

  let detachers: Detach[] = [];
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let running = false;

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
      if (!running) return;
      running = false;

      for (const detach of detachers) detach();
      detachers = [];

      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }

      queue.stop();
    },
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    report,
    async flush() {
      await queue.flush();
    },
  };
}
