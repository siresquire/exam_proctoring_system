/**
 * Shared types for @proctor/core. No React, no DOM-lib-only globals at the
 * type level beyond what `lib: ["ES2021", "DOM"]` already provides (see
 * tsconfig.json) — this package must stay usable from any framework.
 */

/**
 * The full set of client-observable integrity events the proctoring engine
 * can emit, plus the session lifecycle/heartbeat events the server also
 * accepts (see supabase/migrations/20260704000006_proctor_sessions_events_media.sql
 * — the `event_type` CHECK constraint there is the source of truth this
 * union must stay in sync with).
 */
export type ProctorEvent =
  | "tab_hidden"
  | "tab_visible"
  | "window_blur"
  | "window_focus"
  | "fullscreen_exit"
  | "fullscreen_enter"
  | "copy_attempt"
  | "paste_attempt"
  | "cut_attempt"
  | "contextmenu"
  | "connection_lost"
  | "connection_restored"
  | "snapshot_captured"
  | "camera_lost"
  | "multi_monitor_detected"
  | "page_unload"
  | "heartbeat"
  | "session_start"
  | "session_end"
  | "concurrent_session_detected"
  /** Phase 1.5: server-logged when a claimed index number differs from profiles.student_number. Client never emits this itself — it's surfaced for display only if a host app reads it back via SELECT. */
  | "identity_mismatch"
  /** Phase 1.5: server-appended when violation_count reaches violation_limit (log_proctor_events). The engine surfaces this as a local signal (see ProctorEngine.onTerminated) rather than the client emitting/queuing it itself — the server already recorded it. */
  | "session_terminated"
  /**
   * Phase 1.6: no face visible in a webcam snapshot, DEBOUNCED over
   * `noFaceThreshold` consecutive no-face snapshots (default 2 — see
   * engine.ts) before it is emitted at all. This is a soft signal: low
   * light and darker skin tones both reduce face-detector recall
   * (docs/RESEARCH.md §3), so a single miss is never reported — only a
   * run of consecutive misses, and even then it only ever feeds the same
   * human-review pipeline as every other event, never an automatic fail.
   */
  | "no_face_detected"
  /**
   * Phase 1.6: 2+ faces detected in a single webcam snapshot — no
   * debounce (a second person is a stronger signal than a momentary
   * face-detector miss), but still routed to human review like every
   * other flag, never an automatic penalty.
   */
  | "multiple_faces_detected";

export type ProctorSeverity = "info" | "low" | "medium" | "high";

/** Integrity tiers, PLAN.md §2 (T1 quiz .. T4 high-stakes). */
export type ProctorTier = 1 | 2 | 3 | 4;

/** A single event as queued client-side, before being batched/sent. */
export interface ProctorEventPayload {
  event_type: ProctorEvent;
  severity: ProctorSeverity;
  /** Client-reported timestamp (ISO 8601). The server stamps its own received_at separately. */
  occurred_at: string;
  meta?: Record<string, unknown>;
}

/** Emitted to `engine.on()` listeners — same shape plus nothing sensitive. */
export interface ProctorEngineEvent extends ProctorEventPayload {}

/**
 * Server's response to a log_proctor_events batch (Phase 1.5) — the RPC
 * always returns this shape now, so the client learns whether *this* batch
 * pushed the session over its violation_limit without a second round-trip.
 */
export interface ProctorLogResult {
  accepted: boolean | number;
  session_status: string;
  violation_count: number;
  violation_limit: number;
}

/**
 * Transport adapter: how batched events leave the browser. Implemented in
 * apps/web (Supabase RPC) — the engine itself never imports @supabase/*.
 */
export interface ProctorTransportAdapter {
  /**
   * Send a batch of events for a session. Throwing means "retry me".
   * Resolves with the server's ProctorLogResult when the transport can
   * surface one (Supabase RPC); a void-returning adapter (e.g. in tests)
   * is still valid — the engine only acts on a result when present.
   */
  sendEvents(sessionId: string, events: ProctorEventPayload[]): Promise<ProctorLogResult | void>;
}

export interface SnapshotMeta {
  capturedAt: string;
  /** e.g. "image/jpeg" */
  mimeType: string;
}

/**
 * Storage adapter: where webcam snapshots/clips land. Local Supabase
 * Storage today (see supabase/migrations/20260704000007_proctor_rls_and_storage.sql);
 * swapping in Cloudflare R2 later (PLAN.md §1) means writing a new adapter
 * that implements this interface, not touching the engine. Keep it this
 * thin on purpose — presigned-URL uploads (R2) and direct-to-Supabase
 * uploads both fit "hand me a blob + metadata, you deal with the bytes."
 */
export interface ProctorStorageAdapter {
  uploadSnapshot(sessionId: string, blob: Blob, meta: SnapshotMeta): Promise<void>;
}

/**
 * Phase 1.6: framework-agnostic face-presence detector interface. Injected
 * by the host app (apps/web wires a MediaPipe Tasks Vision implementation —
 * see apps/web/lib/proctor/face-detector.ts) so this package never depends
 * on @mediapipe/tasks-vision or any ML runtime. `detect` receives whatever
 * bitmap-like source the host's webcam capture already has on hand
 * (ImageBitmap/HTMLVideoElement/HTMLCanvasElement — kept as `unknown` here
 * so proctor-core doesn't need DOM image types beyond what it already
 * pulls in) and returns just the count the engine needs to decide severity.
 *
 * Fairness note (docs/RESEARCH.md §3, PLAN.md Phase 1.6): face detectors
 * have documented accuracy gaps under low light and for darker skin tones.
 * That is precisely why the engine never treats a detector result as proof
 * — see `noFaceThreshold` debouncing on ProctorEngineOptions and the
 * `no_face_detected`/`multiple_faces_detected` doc comments on ProctorEvent.
 */
export interface FaceDetector {
  detect(bitmap: ImageBitmap): Promise<{ faceCount: number }>;
}

export interface ProctorEngineAdapters {
  transport: ProctorTransportAdapter;
  storage?: ProctorStorageAdapter;
  /** Optional — omitting it simply disables face-presence detection (e.g. in unit tests or on unsupported devices). */
  faceDetector?: FaceDetector;
}

export interface ProctorEngineOptions {
  /** How often to capture a webcam snapshot, ms. Default 20000. Ignored if webcam isn't started. */
  snapshotIntervalMs?: number;
  /** How often to emit a heartbeat event, ms. Default 20000. */
  heartbeatIntervalMs?: number;
  /** How often to flush the queued event batch, ms. Default 5000. */
  batchIntervalMs?: number;
  tier?: ProctorTier;
  /** localStorage key prefix for the offline buffer. Default "proctor-core". */
  storageKeyPrefix?: string;
  /**
   * Phase 1.6: how many CONSECUTIVE no-face snapshots must occur before a
   * single debounced `no_face_detected` event is emitted. Default 2 (at the
   * default 20s snapshot interval, that's ~40s of continuous absence before
   * anything is reported — a brief look-away or one bad frame never counts).
   * A face reappearing resets the run to 0. Deliberately conservative: this
   * is a soft signal that only ever feeds human review (see FaceDetector).
   */
  noFaceThreshold?: number;
  /**
   * Phase 1.6: severity assigned to a debounced no_face_detected event.
   * Default "medium" (RESEARCH.md §3 taxonomy: "Face not visible" = Medium).
   * Overridable so a host app (e.g. the demo harness) can bump it to "high"
   * to observe it counting toward the violation-limit termination flow —
   * real exams should leave this at the tier default unless there's a
   * specific integrity-policy reason to escalate it.
   */
  noFaceSeverity?: ProctorSeverity;
  /**
   * Phase 1.6: severity assigned to multiple_faces_detected. Default "high"
   * (RESEARCH.md §3: "Multiple faces / second person" = High) — a second
   * face in frame is a much stronger signal than a momentary detector miss,
   * so unlike no-face this is not debounced and defaults straight to high.
   * Still overridable for the same reason as noFaceSeverity.
   */
  multipleFacesSeverity?: ProctorSeverity;
}

export interface ProctorEngineConfig {
  sessionId: string;
  adapters: ProctorEngineAdapters;
  options?: ProctorEngineOptions;
}

export type ProctorEventListener = (event: ProctorEngineEvent) => void;

export type ProctorTerminationListener = (result: ProctorLogResult) => void;

/**
 * Phase 1.6: fires on EVERY accepted log_proctor_events batch response,
 * terminal or not — unlike onTerminated (which only fires once, at the
 * moment the session crosses violation_limit), this lets a host app show a
 * live "N of limit" strike counter (see the demo's ViolationHarness) that
 * updates as each batch is confirmed by the server, not just at the end.
 */
export type ProctorViolationUpdateListener = (result: ProctorLogResult) => void;

export interface ProctorEngine {
  start(): void;
  stop(): void;
  on(listener: ProctorEventListener): () => void;
  /**
   * Phase 1.5: called when a log_proctor_events batch response reports
   * session_status === "terminated" (violation_limit reached). The server
   * has already recorded session_terminated as a proctor_events row — this
   * is purely a local notification so the host app can lock its UI; it is
   * never itself queued/re-sent.
   */
  onTerminated(listener: ProctorTerminationListener): () => void;
  /**
   * Phase 1.6: called on every accepted log_proctor_events batch response
   * (terminal or not) — see ProctorViolationUpdateListener. Fires BEFORE
   * onTerminated when a batch happens to also cross the limit, so a host
   * app can update a live strike counter and a termination banner from two
   * independent, single-purpose listeners instead of overloading one.
   */
  onViolationUpdate(listener: ProctorViolationUpdateListener): () => void;
  /** Manually enqueue+emit an event (used by webcam snapshot capture, or a host app's own signal). */
  report(event: ProctorEvent, severity: ProctorSeverity, meta?: Record<string, unknown>): void;
  /**
   * Phase 1.6: run face-presence detection on a just-captured snapshot
   * bitmap and update the debounce state. The host app calls this once per
   * webcam snapshot (right after `report("snapshot_captured", ...)`) — the
   * engine does not capture frames itself, it only interprets them. A no-op
   * if `adapters.faceDetector` was not provided at construction. May emit
   * `no_face_detected` (after `noFaceThreshold` consecutive misses) or
   * `multiple_faces_detected` (immediately) via the normal report()/on()
   * pipeline.
   */
  processSnapshot(bitmap: ImageBitmap): Promise<void>;
  /**
   * Phase 1.6: change the no_face_detected severity on an already-running
   * engine (the ProctorEngineOptions.noFaceSeverity value is otherwise
   * fixed at construction time). Exists so a host app's UI — the demo
   * harness's medium/high toggle — can flip the policy live and watch the
   * next debounced no-face signal reflect it immediately, without tearing
   * down and recreating the whole engine (which would also drop its
   * pending event queue).
   */
  setNoFaceSeverity(severity: ProctorSeverity): void;
  /** Best-effort immediate flush (e.g. before navigating away). */
  flush(): Promise<void>;
}

/** Severity mapping per RESEARCH.md §3's industry taxonomy. Tier-aware: some signals escalate at higher tiers. */
export function defaultSeverity(event: ProctorEvent, tier: ProctorTier = 2): ProctorSeverity {
  switch (event) {
    case "tab_hidden":
      return "medium";
    case "tab_visible":
    case "window_focus":
    case "fullscreen_enter":
    case "connection_restored":
    case "snapshot_captured":
    case "session_start":
    case "session_end":
    case "heartbeat":
      return "info";
    case "window_blur":
      return "low";
    case "fullscreen_exit":
      return tier >= 3 ? "high" : "medium";
    case "copy_attempt":
    case "paste_attempt":
    case "cut_attempt":
      return tier >= 3 ? "medium" : "low";
    case "contextmenu":
      return "low";
    case "connection_lost":
      return "low";
    case "camera_lost":
      return "high";
    case "multi_monitor_detected":
      return "info";
    case "page_unload":
      return "medium";
    case "concurrent_session_detected":
    case "identity_mismatch":
    case "session_terminated":
    case "multiple_faces_detected":
      return "high";
    case "no_face_detected":
      // RESEARCH.md §3 taxonomy: "Face not visible" = Medium. Overridable
      // per-engine via ProctorEngineOptions.noFaceSeverity (see engine.ts) —
      // this is only the fallback when no override is configured.
      return "medium";
    default:
      return "info";
  }
}
