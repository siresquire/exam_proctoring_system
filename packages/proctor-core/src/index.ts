/**
 * @proctor/core — framework-agnostic proctoring engine.
 *
 * Shared by System 1 (proctored Google Forms wrapper) and System 2 (full
 * assessment platform). No React import anywhere in this package — adapters
 * for transport (event upload) and storage (snapshot/clip upload) are
 * injected by the host app (see apps/web/lib/proctor/supabase-adapters.ts),
 * so this package has zero runtime dependencies and zero framework coupling.
 *
 * Public surface:
 *   createProctorEngine(config) -> { start, stop, on, report, flush }
 *   startWebcam() / isWebcamSupported()  -- standalone camera helpers, used
 *     by the ConsentScreen's camera-check step before a session even exists
 *   requestFullscreen() / exitFullscreen()
 *   defaultSeverity(event, tier) -- RESEARCH.md §3 taxonomy, tier-aware
 *   Types: ProctorEvent, ProctorSeverity, ProctorTier, adapters, etc.
 */

export const version = "0.1.0";

export { createProctorEngine } from "./engine";
export {
  requestFullscreen,
  exitFullscreen,
  collectVisibility,
  collectWindowFocus,
  collectFullscreen,
  collectClipboard,
  collectContextMenu,
  collectConnection,
  collectUnload,
  checkMultiMonitor,
} from "./collectors";
export { startWebcam, isWebcamSupported } from "./webcam";
export type { WebcamHandle } from "./webcam";
export { createEventQueue } from "./queue";
export type { EventQueue } from "./queue";
export { defaultSeverity } from "./types";
export type {
  ProctorEvent,
  ProctorSeverity,
  ProctorTier,
  ProctorEventPayload,
  ProctorEngineEvent,
  ProctorEventListener,
  ProctorEngineAdapters,
  ProctorTransportAdapter,
  ProctorStorageAdapter,
  ProctorEngineOptions,
  ProctorEngineConfig,
  ProctorEngine,
  ProctorLogResult,
  ProctorTerminationListener,
  ProctorViolationUpdateListener,
  SnapshotMeta,
  FaceDetector,
} from "./types";
