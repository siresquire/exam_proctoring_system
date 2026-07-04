/**
 * @proctor/core — framework-agnostic proctoring engine.
 *
 * Shared by System 1 (proctored Google Forms wrapper) and System 2 (full
 * assessment platform). This is currently a placeholder stub; the real
 * heartbeat/event-capture/upload pipeline lands in Phase 1 (see PLAN.md).
 */

/** Package version, bumped alongside meaningful engine changes. */
export const version = "0.0.1";

/**
 * The full set of client-observable integrity events the proctoring engine
 * can emit. Each event is timestamped and, in the real pipeline, batched and
 * uploaded (with offline buffering) to the proctor_events table.
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
  | "contextmenu"
  | "connection_lost"
  | "connection_restored"
  | "snapshot_captured";
