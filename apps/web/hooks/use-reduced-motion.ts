"use client";

import * as React from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(callback: () => void): () => void {
  const query = window.matchMedia(QUERY);
  query.addEventListener("change", callback);
  return () => query.removeEventListener("change", callback);
}

function getSnapshot(): boolean {
  return window.matchMedia(QUERY).matches;
}

function getServerSnapshot(): boolean {
  return false;
}

/**
 * Tracks `prefers-reduced-motion` live (unlike lib/notify.ts's one-shot
 * `prefersReducedMotion()`, which is read once at call time for a SweetAlert2
 * popup) — chart components stay mounted, so a user flipping the OS setting
 * mid-session should immediately stop/start animating without a reload.
 * `useSyncExternalStore` (not a state+effect pair, which the
 * react-hooks/set-state-in-effect rule flags as a cascading-render risk —
 * see components/admin/system-overview.tsx's identical convention) is the
 * correct primitive for subscribing to a browser API that changes outside
 * React's own render cycle. Defaults to `false` on the server, the safe
 * direction (worst case one animated frame before the real preference
 * applies, never the reverse).
 */
export function useReducedMotion(): boolean {
  return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
