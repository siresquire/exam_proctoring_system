/**
 * Phase 3d-i: server-authoritative countdown helpers. The exam room never
 * trusts the client's own clock for "how much time is left" — instead it
 * computes a one-time offset between the browser's Date.now() and the
 * server's `now()` (returned by get_attempt_questions), then always derives
 * "time remaining" from deadline_at - (Date.now() - offset), so a wrong
 * local clock never produces an incorrect countdown or an early/late
 * client-side auto-submit.
 */

/** offsetMs = serverNow - clientNow at the moment of measurement, so serverTimeNow() = Date.now() + offsetMs stays correct as time passes. */
export function computeServerOffsetMs(serverNowIso: string, clientNowMs: number): number {
  return new Date(serverNowIso).getTime() - clientNowMs;
}

export function remainingMs(deadlineIso: string, offsetMs: number): number {
  const serverNow = Date.now() + offsetMs;
  return new Date(deadlineIso).getTime() - serverNow;
}

export function formatCountdown(ms: number): string {
  const clamped = Math.max(0, ms);
  const totalSeconds = Math.floor(clamped / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** The DESIGN.md §3 Robust announcement thresholds (30/15/5/1 min), in ms, descending. */
export const ANNOUNCE_THRESHOLDS_MS = [30 * 60_000, 15 * 60_000, 5 * 60_000, 1 * 60_000];

export function formatClockTime(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour12: false });
}
