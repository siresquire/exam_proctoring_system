"use client";

import { useState } from "react";
import type { ProctorEngine, ProctorEvent, ProctorSeverity } from "@proctor/core";
import { AlertTriangle, Info, ShieldAlert, ToggleLeft, ToggleRight } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { ViolationPolicyState } from "@/components/proctor/violation-policy-editor";
import { cn } from "@/lib/utils";

/**
 * Phase 1.6 demo violation testing harness: manual triggers for every
 * violation type, so a reviewer/tester can exercise the full event -> feed
 * -> server -> termination pipeline on demand without waiting for a real
 * tab switch or webcam miss to happen naturally. This is ADDITIONAL to the
 * real signal collectors the engine already runs (tab switch, window blur,
 * clipboard, etc.) — every button here calls the SAME `engine.report()` the
 * real collectors use, so what flows to the feed/server/termination logic
 * is indistinguishable from an organically-detected signal.
 *
 * Phase 1.7: grouping and "counts toward termination" labeling is now
 * DERIVED from the `policy` prop (the same ViolationPolicyState the student
 * configured in the pre-session ViolationPolicyEditor for this session),
 * not a hard-coded severity table — severity is server-assigned from
 * proctor_sessions.violation_policy, so a fixed client-side grouping would
 * silently go stale the moment someone changes the policy (e.g. the
 * default policy now makes tab_hidden/window_blur/contextmenu all
 * high+counting, which the OLD fixed low/medium groupings here would have
 * mislabeled). The button still reports whatever severity the policy says
 * for display/local-feed purposes — the server ignores it either way and
 * looks up its own stored snapshot.
 *
 * "Counts toward termination" is called out explicitly (a dedicated
 * heading + a live strike counter) because the whole point of the harness
 * is to make the 3-strike auto-termination policy legible, not just
 * theoretically true — DESIGN.md's "visibility of system status" principle
 * applied to an anti-cheat mechanic that's normally invisible until it
 * fires.
 */

interface ViolationDef {
  event: ProctorEvent;
  label: string;
  hint?: string;
}

/** Events the harness can trigger whose policy entry lives in ViolationPolicyState (i.e. everything the editor makes configurable). */
const POLICY_DRIVEN_EVENTS: ViolationDef[] = [
  { event: "tab_hidden", label: "Tab switched away" },
  { event: "window_blur", label: "Window lost focus" },
  { event: "fullscreen_exit", label: "Exited fullscreen" },
  { event: "copy_attempt", label: "Copied exam content" },
  { event: "paste_attempt", label: "Pasted into the exam" },
  { event: "cut_attempt", label: "Cut exam content" },
  { event: "contextmenu", label: "Right-click menu opened" },
  { event: "camera_lost", label: "Camera feed lost" },
  {
    event: "multiple_faces_detected",
    label: "Multiple faces detected",
    hint: "faceCount: 2",
  },
  {
    event: "display_configuration_changed",
    label: "Display configuration changed",
    hint: "e.g. second monitor plugged in mid-exam",
  },
  { event: "concurrent_session_detected", label: "Concurrent session detected" },
  { event: "identity_mismatch", label: "Identity mismatch flagged" },
  { event: "connection_lost", label: "Connection lost" },
];

/** Never configurable, never a violation — the one-shot START-of-session observation. Always info, never counts. */
const INFO_EVENTS: ViolationDef[] = [
  { event: "multi_monitor_detected", label: "Multiple displays detected (start of session)" },
];

const SEVERITY_BADGE: Record<ProctorSeverity, "secondary" | "outline" | "destructive"> = {
  info: "secondary",
  low: "outline",
  medium: "outline",
  high: "destructive",
};

interface ViolationHarnessProps {
  engine: ProctorEngine | null;
  disabled: boolean;
  violationCount: number;
  violationLimit: number;
  /** The effective policy chosen for THIS session (ViolationPolicyEditor) — drives grouping/labels below. */
  policy: ViolationPolicyState;
  noFaceSeverity: "medium" | "high";
  onToggleNoFaceSeverity: () => void;
}

function ViolationButton({
  def,
  severity,
  engine,
  disabled,
  metaOverride,
}: {
  def: ViolationDef;
  severity: ProctorSeverity;
  engine: ProctorEngine | null;
  disabled: boolean;
  metaOverride?: Record<string, unknown>;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-auto min-h-11 w-full justify-start text-left"
      disabled={disabled || !engine}
      onClick={() =>
        engine?.report(def.event, severity, { source: "demo-harness", ...metaOverride })
      }
    >
      <span className="flex flex-col items-start gap-0.5 py-0.5">
        <span>{def.label}</span>
        {def.hint ? <span className="text-muted-foreground text-xs">{def.hint}</span> : null}
      </span>
    </Button>
  );
}

export function ViolationHarness({
  engine,
  disabled,
  violationCount,
  violationLimit,
  policy,
  noFaceSeverity,
  onToggleNoFaceSeverity,
}: ViolationHarnessProps) {
  const [open, setOpen] = useState(true);
  const strikesRemaining = Math.max(0, violationLimit - violationCount);

  // Split the policy-driven events into "counts" vs "logged only" groups
  // from the CURRENT policy, so the grouping always matches what the
  // server will actually do for this session — never a stale hard-coded
  // table. no_face_detected is handled by its own dedicated toggle below
  // (noFaceSeverity), so it is excluded from this list to avoid presenting
  // two controls for the same event.
  const countingEvents = POLICY_DRIVEN_EVENTS.filter((def) => policy[def.event]?.counts);
  const loggedOnlyEvents = POLICY_DRIVEN_EVENTS.filter((def) => !policy[def.event]?.counts);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldAlert aria-hidden className="text-primary size-4" />
              Violation testing harness
            </CardTitle>
            <CardDescription className="text-xs">
              Manually trigger any violation type. Each button reports a real event through the
              engine — it reaches the live feed and the server exactly like an organic signal.
              Grouping below reflects the violation policy you set before starting this session.
            </CardDescription>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded={open}
            aria-controls="violation-harness-body"
            onClick={() => setOpen((prev) => !prev)}
          >
            {open ? "Hide" : "Show"}
          </Button>
        </div>
      </CardHeader>

      {open ? (
        <CardContent id="violation-harness-body" className="space-y-5">
          <div
            className="border-destructive bg-destructive/5 flex items-center justify-between gap-3 rounded-md border p-3"
            role="status"
            aria-live="polite"
          >
            <div>
              <p className="text-sm font-medium">
                Strikes (server-confirmed): {violationCount} / {violationLimit}
              </p>
              {/* text-foreground, not text-muted-foreground: on the
                  bg-destructive/5 tint here, muted-foreground measures
                  ~4.33:1 (axe-core: serious color-contrast violation,
                  DESIGN.md requires >=4.5:1 AA). This line is also the
                  substantive "what happens at the limit" statement, not
                  filler caption text, so full-strength foreground is the
                  right call either way. Phase 1.7: this count comes
                  straight from the server's log_proctor_events response
                  (violationCount/violationLimit props), never a local
                  by-severity tally — severity/counting is server-assigned
                  from the session's policy snapshot, so a client-side
                  count could drift from (or be gamed relative to) the
                  server's real strike standing. */}
              <p className="text-xs">
                Reaching the limit ends the session and files a report for your lecturer.{" "}
                {strikesRemaining} strike{strikesRemaining === 1 ? "" : "s"} remaining.
              </p>
            </div>
            <AlertTriangle
              aria-hidden
              className={cn(
                "size-6 shrink-0",
                violationCount >= violationLimit ? "text-destructive" : "text-muted-foreground",
              )}
            />
          </div>

          <div className="flex items-center justify-between gap-3 rounded-md border p-3">
            <div>
              <p className="text-sm font-medium">no_face_detected severity</p>
              <p className="text-muted-foreground text-xs">
                Toggle whether a debounced no-face signal counts toward the strike limit. This
                mirrors the same policy the editor configures for every other event — medium is
                the human-review-only default; high counts as a strike.
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={onToggleNoFaceSeverity}
              aria-pressed={noFaceSeverity === "high"}
            >
              {noFaceSeverity === "high" ? (
                <ToggleRight aria-hidden className="text-destructive" />
              ) : (
                <ToggleLeft aria-hidden />
              )}
              {noFaceSeverity === "high" ? "High (counts as strike)" : "Medium (review only)"}
            </Button>
          </div>

          <section aria-labelledby="harness-counting-heading" className="space-y-2">
            <h3
              id="harness-counting-heading"
              className="text-destructive flex items-center gap-1.5 text-sm font-semibold"
            >
              <Badge variant={SEVERITY_BADGE.high}>counts</Badge>
              Counts toward termination under the current policy
            </h3>
            {countingEvents.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                No events count under the current policy — every violation below was switched to
                &quot;logged only&quot; in the policy editor.
              </p>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {countingEvents.map((def) => (
                  <ViolationButton
                    key={def.event}
                    def={def}
                    severity={policy[def.event]?.severity ?? "high"}
                    engine={engine}
                    disabled={disabled}
                  />
                ))}
              </div>
            )}
          </section>

          <section aria-labelledby="harness-logged-heading" className="space-y-2">
            <h3
              id="harness-logged-heading"
              className="flex items-center gap-1.5 text-sm font-semibold"
            >
              <Badge variant={SEVERITY_BADGE.medium}>logged only</Badge>
              Logged, does not count toward termination under the current policy
            </h3>
            {loggedOnlyEvents.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                Every violation below counts under the current policy — none are set to
                &quot;logged only&quot;.
              </p>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {loggedOnlyEvents.map((def) => (
                  <ViolationButton
                    key={def.event}
                    def={def}
                    severity={policy[def.event]?.severity ?? "info"}
                    engine={engine}
                    disabled={disabled}
                  />
                ))}
              </div>
            )}
          </section>

          <section aria-labelledby="harness-info-heading" className="space-y-2">
            <h3 id="harness-info-heading" className="flex items-center gap-1.5 text-sm font-semibold">
              <Badge variant={SEVERITY_BADGE.info}>info</Badge>
              Informational only — never configurable, never counts
            </h3>
            <div className="grid gap-2 sm:grid-cols-2">
              {INFO_EVENTS.map((def) => (
                <ViolationButton
                  key={def.event}
                  def={def}
                  severity="info"
                  engine={engine}
                  disabled={disabled}
                />
              ))}
            </div>
          </section>

          <p className="text-muted-foreground flex items-start gap-2 text-xs">
            <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            Client-side signals are evidence, not proof. Every flag here — manual or organic —
            routes to the same human-review pipeline before any real consequence. The severity
            shown on each button is a local display hint only: the server assigns the real
            severity and strike-counting decision from this session&apos;s stored policy,
            ignoring whatever the client reports.
          </p>
        </CardContent>
      ) : null}
    </Card>
  );
}
