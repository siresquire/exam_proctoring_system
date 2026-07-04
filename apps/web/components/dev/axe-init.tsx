"use client";

import * as React from "react";

/**
 * Runs a full-page axe-core scan in development only and logs violations to
 * the console. Never included in production bundles (the dynamic import +
 * NODE_ENV guard keeps it out of the client chunk shipped to real users).
 *
 * We call `axe-core` directly rather than the `@axe-core/react` wrapper:
 * that wrapper's own README states it does not support React 18+ (it
 * monkey-patches `React.createElement`, which throws under React's current
 * module/JSX-runtime setup). Running `axe.run()` against the DOM on an
 * interval is simpler and has no such incompatibility.
 */
export function AxeInit() {
  React.useEffect(() => {
    if (process.env.NODE_ENV !== "development") return;

    let cancelled = false;
    let intervalId: number | undefined;
    let timeoutId: number | undefined;

    void import("axe-core").then((axe) => {
      if (cancelled) return;

      const scan = () => {
        axe.run(document, {}, (error, results) => {
          if (error) {
            console.error("[axe] scan failed", error);
            return;
          }
          if (results.violations.length === 0) return;
          (window as unknown as { __axeViolations?: unknown }).__axeViolations = results.violations;
          console.warn(`[axe] ${results.violations.length} accessibility violation(s):`);
          for (const violation of results.violations) {
            console.warn(
              `[axe] ${violation.impact ?? "unknown"} — ${violation.id}: ${violation.help}`,
              violation.nodes,
            );
          }
        });
      };

      // Initial scan after first paint, then re-scan on a slow interval so
      // navigation between routes gets checked without spamming the console.
      timeoutId = window.setTimeout(scan, 1000);
      intervalId = window.setInterval(scan, 5000);
    });

    return () => {
      cancelled = true;
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      if (intervalId !== undefined) window.clearInterval(intervalId);
    };
  }, []);

  return null;
}
