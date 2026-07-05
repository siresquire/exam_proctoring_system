import type { ProctorEvent } from "./types";

/**
 * Signal collectors: each attaches DOM listeners and calls `emit` with a
 * ProctorEvent, returning a cleanup function that detaches everything.
 * Kept as small independent functions (not a class) so the engine can
 * compose exactly the ones it needs and unit tests can exercise one at a
 * time. No React — this is plain DOM API usage, safe under jsdom/happy-dom.
 */

export type Emit = (event: ProctorEvent, meta?: Record<string, unknown>) => void;
export type Detach = () => void;

/** Page Visibility API — tab switch / minimize. Universal browser support. */
export function collectVisibility(emit: Emit): Detach {
  function handler() {
    emit(document.hidden ? "tab_hidden" : "tab_visible");
  }
  document.addEventListener("visibilitychange", handler);
  return () => document.removeEventListener("visibilitychange", handler);
}

/** window blur/focus — app/window switch. Universal, but doesn't fire for e.g. always-on-top overlays. */
export function collectWindowFocus(emit: Emit): Detach {
  function onBlur() {
    emit("window_blur");
  }
  function onFocus() {
    emit("window_focus");
  }
  window.addEventListener("blur", onBlur);
  window.addEventListener("focus", onFocus);
  return () => {
    window.removeEventListener("blur", onBlur);
    window.removeEventListener("focus", onFocus);
  };
}

/** Fullscreen enter/exit. Esc always exits fullscreen — we detect it, we don't (can't) prevent it. */
export function collectFullscreen(emit: Emit): Detach {
  function handler() {
    emit(document.fullscreenElement ? "fullscreen_enter" : "fullscreen_exit");
  }
  document.addEventListener("fullscreenchange", handler);
  return () => document.removeEventListener("fullscreenchange", handler);
}

/** Requests fullscreen on the given element (defaults to documentElement). Rejects silently if unsupported/denied — caller decides what that means. */
export async function requestFullscreen(
  element: Element = document.documentElement,
): Promise<boolean> {
  try {
    if (!element.requestFullscreen) return false;
    await element.requestFullscreen();
    return true;
  } catch {
    return false;
  }
}

export async function exitFullscreen(): Promise<void> {
  try {
    if (document.fullscreenElement && document.exitFullscreen) {
      await document.exitFullscreen();
    }
  } catch {
    // Nothing sensible to do if the browser refuses — not a proctoring signal itself.
  }
}

/** Copy/cut/paste — clipboard use during the session. `preventDefault` is opt-in per tier (higher tiers may want to block, not just detect). */
export function collectClipboard(emit: Emit, options: { prevent?: boolean } = {}): Detach {
  function onCopy(e: ClipboardEvent) {
    emit("copy_attempt");
    if (options.prevent) e.preventDefault();
  }
  function onCut(e: ClipboardEvent) {
    emit("cut_attempt");
    if (options.prevent) e.preventDefault();
  }
  function onPaste(e: ClipboardEvent) {
    emit("paste_attempt");
    if (options.prevent) e.preventDefault();
  }
  document.addEventListener("copy", onCopy);
  document.addEventListener("cut", onCut);
  document.addEventListener("paste", onPaste);
  return () => {
    document.removeEventListener("copy", onCopy);
    document.removeEventListener("cut", onCut);
    document.removeEventListener("paste", onPaste);
  };
}

/** Right-click / context menu. Detection only by default (prevention is trivially bypassed by DevTools/extensions per RESEARCH.md §3). */
export function collectContextMenu(emit: Emit, options: { prevent?: boolean } = {}): Detach {
  function handler(e: MouseEvent) {
    emit("contextmenu");
    if (options.prevent) e.preventDefault();
  }
  document.addEventListener("contextmenu", handler);
  return () => document.removeEventListener("contextmenu", handler);
}

/** navigator online/offline — connection loss/restore. */
export function collectConnection(emit: Emit): Detach {
  function onOffline() {
    emit("connection_lost");
  }
  function onOnline() {
    emit("connection_restored");
  }
  window.addEventListener("offline", onOffline);
  window.addEventListener("online", onOnline);
  return () => {
    window.removeEventListener("offline", onOffline);
    window.removeEventListener("online", onOnline);
  };
}

/** beforeunload during an active session — student navigating/closing away mid-exam. */
export function collectUnload(emit: Emit): Detach {
  function handler() {
    emit("page_unload");
  }
  window.addEventListener("beforeunload", handler);
  return () => window.removeEventListener("beforeunload", handler);
}

/**
 * Multi-monitor check via `screen.isExtended` (Chrome/Edge only, needs the
 * Window Management permission — RESEARCH.md §3). One-shot info event at
 * session start, not a continuous collector: a second *device* is invisible
 * to this API regardless, so polling it adds no signal, just noise.
 */
export async function checkMultiMonitor(emit: Emit): Promise<void> {
  const screenWithExtended = screen as Screen & { isExtended?: boolean };
  if (typeof screenWithExtended.isExtended === "boolean") {
    if (screenWithExtended.isExtended) {
      emit("multi_monitor_detected", { source: "screen.isExtended" });
    }
    return;
  }
  // getScreenDetails requires a user gesture + permission prompt in most
  // browsers; skip it here to avoid surprising the student with a second
  // permission dialog beyond camera — screen.isExtended is best-effort only.
}

type ScreenWithDetails = Screen & {
  isExtended?: boolean;
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
};

type ScreenDetailsLike = {
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
  screens?: unknown[];
};

interface DisplaySnapshot {
  isExtended: boolean;
  width: number;
  height: number;
}

function readDisplaySnapshot(): DisplaySnapshot {
  const screenWithExtended = screen as ScreenWithDetails;
  return {
    isExtended: Boolean(screenWithExtended.isExtended),
    width: screen.width,
    height: screen.height,
  };
}

function snapshotsDiffer(a: DisplaySnapshot, b: DisplaySnapshot): boolean {
  return a.isExtended !== b.isExtended || a.width !== b.width || a.height !== b.height;
}

/**
 * Phase 1.7: detects a display configuration CHANGE happening mid-session —
 * e.g. a second monitor plugged in via HDMI/VGA/dock after the exam already
 * started, unplugged, or resized/rearranged. Distinct from
 * `checkMultiMonitor` (the one-shot START-of-session observation, which is
 * never itself a violation): this collector only reports a *change* from
 * whatever the state was when it attached, which IS the violation signal.
 *
 * Three independent layers, all best-effort (never a mid-exam permission
 * prompt):
 *   1. `screen.addEventListener('change', ...)` — fires on display geometry
 *      changes in browsers that support it (spec: Screen "change" event).
 *      No permission required.
 *   2. `getScreenDetails()`'s `screenschange` event — ONLY attached if the
 *      "window-management" permission is ALREADY granted (checked via the
 *      Permissions API before ever calling getScreenDetails, which itself
 *      would otherwise trigger a permission prompt — we never prompt mid-
 *      exam, only opportunistically use a grant that already exists from
 *      earlier in the session or a previous visit).
 *   3. A fallback poll of `screen.isExtended` + `screen.width`/`height`
 *      every `pollIntervalMs` (default ~10s) — catches the change even in
 *      browsers with neither event, at the cost of coarser timing.
 *
 * HONEST LIMIT (PLAN.md Phase 1.7): a mirrored splitter or capture card is
 * invisible to all of the above (the OS still reports one display) — no
 * browser API can see it. That gap is mitigated by the webcam/gaze layer
 * (Phase 5), not by this collector.
 */
export function collectDisplayChange(emit: Emit, options: { pollIntervalMs?: number } = {}): Detach {
  const pollIntervalMs = options.pollIntervalMs ?? 10000;
  let baseline = readDisplaySnapshot();
  let screenDetails: ScreenDetailsLike | null = null;

  function reportIfChanged(source: string) {
    const current = readDisplaySnapshot();
    if (snapshotsDiffer(baseline, current)) {
      emit("display_configuration_changed", {
        source,
        previous: baseline,
        current,
      });
      baseline = current;
    }
  }

  function onScreenChange() {
    reportIfChanged("screen.change");
  }

  function onScreensChange() {
    reportIfChanged("screenschange");
  }

  const screenWithDetails = screen as ScreenWithDetails;
  screenWithDetails.addEventListener?.("change", onScreenChange);

  // getScreenDetails() itself prompts for permission if not already
  // granted — never call it speculatively mid-exam. Only use it when the
  // Permissions API confirms "window-management" is already 'granted'
  // (e.g. from earlier in this same session, or a previous visit).
  void (async () => {
    try {
      const nav = navigator as Navigator & {
        permissions?: { query: (opts: { name: string }) => Promise<{ state: string }> };
        getScreenDetails?: () => Promise<ScreenDetailsLike>;
      };
      if (!nav.permissions || !nav.getScreenDetails) return;
      const status = await nav.permissions.query({ name: "window-management" });
      if (status.state !== "granted") return;

      const details = await nav.getScreenDetails();
      screenDetails = details;
      details.addEventListener?.("screenschange", onScreensChange);
    } catch {
      // Permission query unsupported, denied, or getScreenDetails rejected
      // — the screen.change listener and poll fallback still cover us.
    }
  })();

  const pollTimer = setInterval(() => reportIfChanged("poll"), pollIntervalMs);

  return () => {
    screenWithDetails.removeEventListener?.("change", onScreenChange);
    screenDetails?.removeEventListener?.("screenschange", onScreensChange);
    clearInterval(pollTimer);
  };
}
