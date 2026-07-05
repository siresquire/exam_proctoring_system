"use client";

import { useState } from "react";
import type { ProctorEngine, ProctorEvent, ProctorSeverity } from "@proctor/core";
import { AlertTriangle, Info, ShieldAlert, ToggleLeft, ToggleRight } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * Phase 1.6 demo violation testing harness: manual triggers for every
 * violation type, grouped by severity, so a reviewer/tester can exercise
 * the full event -> feed -> server -> termination pipeline on demand
 * without waiting for a real tab switch or webcam miss to happen
 * naturally. This is ADDITIONAL to the real signal collectors the engine
 * already runs (tab switch, window blur, clipboard, etc.) — every button
 * here calls the SAME `engine.report()` the real collectors use, so what
 * flows to the feed/server/termination logic is indistinguishable from an
 * organically-detected signal.
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

const INFO_EVENTS: ViolationDef[] = [
  { event: "multi_monitor_detected", label: "Multiple displays detected" },
];

const LOW_EVENTS: ViolationDef[] = [
  { event: "window_blur", label: "Window lost focus" },
  { event: "contextmenu", label: "Right-click menu opened" },
  { event: "connection_lost", label: "Connection lost" },
];

const MEDIUM_EVENTS: ViolationDef[] = [
  { event: "tab_hidden", label: "Tab switched away" },
  { event: "page_unload", label: "Page closed/navigated away" },
];

const HIGH_EVENTS: ViolationDef[] = [
  { event: "camera_lost", label: "Camera feed lost" },
  { event: "concurrent_session_detected", label: "Concurrent session detected" },
  { event: "identity_mismatch", label: "Identity mismatch flagged" },
  {
    event: "multiple_faces_detected",
    label: "Multiple faces detected",
    hint: "faceCount: 2",
  },
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
  noFaceSeverity,
  onToggleNoFaceSeverity,
}: ViolationHarnessProps) {
  const [open, setOpen] = useState(true);
  const strikesRemaining = Math.max(0, violationLimit - violationCount);

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
                High-severity strikes: {violationCount} / {violationLimit}
              </p>
              {/* text-foreground, not text-muted-foreground: on the
                  bg-destructive/5 tint here, muted-foreground measures
                  ~4.33:1 (axe-core: serious color-contrast violation,
                  DESIGN.md requires >=4.5:1 AA). This line is also the
                  substantive "what happens at 3 strikes" statement, not
                  filler caption text, so full-strength foreground is the
                  right call either way. */}
              <p className="text-xs">
                Three high-severity violations end the session and file a report for your
                lecturer. {strikesRemaining} strike{strikesRemaining === 1 ? "" : "s"} remaining.
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
                Toggle whether a debounced no-face signal counts toward the 3-strike limit.
                Real exams default to medium (human-review signal only); flip to high to watch
                it start counting.
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

          <section aria-labelledby="harness-high-heading" className="space-y-2">
            <h3
              id="harness-high-heading"
              className="text-destructive flex items-center gap-1.5 text-sm font-semibold"
            >
              <Badge variant={SEVERITY_BADGE.high}>high</Badge>
              Counts toward termination (high severity)
            </h3>
            <div className="grid gap-2 sm:grid-cols-2">
              {HIGH_EVENTS.map((def) => (
                <ViolationButton
                  key={def.event}
                  def={def}
                  severity="high"
                  engine={engine}
                  disabled={disabled}
                />
              ))}
            </div>
          </section>

          <section aria-labelledby="harness-medium-heading" className="space-y-2">
            <h3 id="harness-medium-heading" className="flex items-center gap-1.5 text-sm font-semibold">
              <Badge variant={SEVERITY_BADGE.medium}>medium</Badge>
              Logged, does not count toward termination
            </h3>
            <div className="grid gap-2 sm:grid-cols-2">
              {MEDIUM_EVENTS.map((def) => (
                <ViolationButton
                  key={def.event}
                  def={def}
                  severity="medium"
                  engine={engine}
                  disabled={disabled}
                />
              ))}
            </div>
          </section>

          <section aria-labelledby="harness-low-heading" className="space-y-2">
            <h3 id="harness-low-heading" className="flex items-center gap-1.5 text-sm font-semibold">
              <Badge variant={SEVERITY_BADGE.low}>low</Badge>
              Minor signals
            </h3>
            <div className="grid gap-2 sm:grid-cols-2">
              {LOW_EVENTS.map((def) => (
                <ViolationButton
                  key={def.event}
                  def={def}
                  severity="low"
                  engine={engine}
                  disabled={disabled}
                />
              ))}
            </div>
          </section>

          <section aria-labelledby="harness-info-heading" className="space-y-2">
            <h3 id="harness-info-heading" className="flex items-center gap-1.5 text-sm font-semibold">
              <Badge variant={SEVERITY_BADGE.info}>info</Badge>
              Informational only
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
            routes to the same human-review pipeline before any real consequence.
          </p>
        </CardContent>
      ) : null}
    </Card>
  );
}
