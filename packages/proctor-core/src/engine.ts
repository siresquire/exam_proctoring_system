import {
  checkMultiMonitor,
  collectClipboard,
  collectConnection,
  collectContextMenu,
  collectDisplayChange,
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
  ProctorViolationUpdateListener,
} from "./types";

const DEFAULT_HEARTBEAT_INTERVAL_MS = 20000;
/** Phase 1.6 default — see ProctorEngineOptions.noFaceThreshold doc comment in types.ts. */
const DEFAULT_NO_FACE_THRESHOLD = 2;

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
  const noFaceThreshold = options.noFaceThreshold ?? DEFAULT_NO_FACE_THRESHOLD;

  const listeners = new Set<ProctorEventListener>();
  const terminationListeners = new Set<ProctorTerminationListener>();
  const violationUpdateListeners = new Set<ProctorViolationUpdateListener>();
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
      // Fires on every accepted batch, terminal or not — lets a host app
      // keep a live strike counter (ViolationHarness) in sync with the
      // server's actual count, not just react at the moment of
      // termination.
      for (const listener of violationUpdateListeners) listener(result);

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

  // Phase 1.6 face-presence debounce state. Kept as plain closure variables
  // (not a class) to match the rest of this file's style — see
  // processSnapshot below for the actual debounce/threshold logic, unit
  // tested in face-detection.test.ts with a fake FaceDetector.
  let consecutiveNoFace = 0;
  // Mutable (not read straight from `options`) so setNoFaceSeverity can
  // change it on an already-running engine — see the doc comment on
  // ProctorEngine.setNoFaceSeverity in types.ts.
  let noFaceSeverity = options.noFaceSeverity ?? defaultSeverity("no_face_detected", tier);

  async function processSnapshot(bitmap: ImageBitmap): Promise<void> {
    const detector = adapters.faceDetector;
    if (!detector) return;

    let faceCount: number;
    try {
      const result = await detector.detect(bitmap);
      faceCount = result.faceCount;
    } catch {
      // Detector failure (model not loaded, WASM crash, etc.) is not itself
      // proctoring evidence — fail open rather than flag the student for an
      // infrastructure problem on their device.
      return;
    }

    if (faceCount >= 2) {
      // Not debounced: a second face is a much stronger signal than a
      // momentary miss. Still just a flag for human review (see the
      // ProctorEvent doc comment in types.ts and RESEARCH.md §3).
      consecutiveNoFace = 0;
      report(
        "multiple_faces_detected",
        options.multipleFacesSeverity ?? defaultSeverity("multiple_faces_detected", tier),
        { faceCount },
      );
      return;
    }

    if (faceCount === 0) {
      consecutiveNoFace += 1;
      if (consecutiveNoFace >= noFaceThreshold) {
        report("no_face_detected", noFaceSeverity, {
          faceCount,
          consecutiveMisses: consecutiveNoFace,
        });
        // Reset after reporting so a continued absence produces one flag per
        // threshold-sized run rather than one every single snapshot — still
        // detects a student who stays away for the whole exam (it just
        // fires again after another `noFaceThreshold` misses), without
        // flooding the feed/violation count for a single continuous absence.
        consecutiveNoFace = 0;
      }
      return;
    }

    // Exactly one face: the expected state. Reset the miss streak.
    consecutiveNoFace = 0;
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
        // Phase 1.7: mid-session display-configuration changes (second
        // monitor plugged in via HDMI/VGA/dock, unplugged, or resized).
        // Independent of checkMultiMonitor below, which only observes the
        // START-of-session state.
        collectDisplayChange(emit),
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
    onViolationUpdate(listener) {
      violationUpdateListeners.add(listener);
      return () => violationUpdateListeners.delete(listener);
    },
    report,
    processSnapshot,
    setNoFaceSeverity(severity) {
      noFaceSeverity = severity;
    },
    async flush() {
      await queue.flush();
    },
  };
}
