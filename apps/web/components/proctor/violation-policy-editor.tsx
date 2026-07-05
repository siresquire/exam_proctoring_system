"use client";

import { useId, useMemo, useState } from "react";
import type { ProctorEvent, ProctorSeverity } from "@proctor/core";
import { Info, ListChecks, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/**
 * Phase 1.7: lecturer/admin/super_admin-configurable violation policy editor
 * (PLAN.md Phase 1.7). Lists every VIOLATION-TYPE event (the benign
 * lifecycle events — heartbeat, snapshot_captured, tab_visible, etc. — are
 * never shown here; they are never violations and are not configurable) with
 * a "counts toward the 3-strike termination" toggle and a severity select,
 * prefilled from the server's default_violation_policy() defaults. The
 * chosen policy is passed as `violation_policy` to start_proctor_session,
 * which validates and snapshots it server-side — this component itself
 * asserts nothing; it only builds the override object.
 *
 * Server-assigned severity (Phase 1.7 anti-tamper fix, see
 * supabase/migrations/20260705000004_violation_policy.sql): whatever is
 * chosen here becomes the SERVER's source of truth for that session, not a
 * client-side suggestion — log_proctor_events ignores any severity value an
 * event payload carries and looks up the session's stored policy instead.
 * That is exactly why this editor is meaningful: it is the one place the
 * "client can't dodge strikes" policy is actually configured.
 */

export type ViolationPolicyState = Record<
  ProctorEvent,
  { severity: ProctorSeverity; counts: boolean }
>;

interface ViolationDef {
  event: ProctorEvent;
  label: string;
  description: string;
  /** Fairness note shown beneath this row only (currently just connection_lost). */
  fairnessNote?: string;
}

// Mirrors public.default_violation_policy() (20260705000004_violation_policy.sql)
// minus the benign lifecycle/observation entries, which are never shown as
// configurable violations here: tab_visible, window_focus, fullscreen_enter,
// connection_restored, snapshot_captured, heartbeat, session_start,
// session_end, page_unload, multi_monitor_detected (the start-of-session
// observation — display_configuration_changed below is the mid-exam
// CHANGE, which is the actual violation), and session_terminated
// (server-generated only, never client-triggerable, not editable).
const VIOLATION_DEFS: ViolationDef[] = [
  {
    event: "tab_hidden",
    label: "Switching tabs / minimizing",
    description: "The exam tab is switched away from or the window is minimized.",
  },
  {
    event: "window_blur",
    label: "Window loses focus",
    description: "Another application or window is brought to the foreground.",
  },
  {
    event: "fullscreen_exit",
    label: "Exiting fullscreen",
    description: "The student leaves the required fullscreen exam view.",
  },
  {
    event: "copy_attempt",
    label: "Copying exam content",
    description: "Text on the exam page is copied to the clipboard.",
  },
  {
    event: "paste_attempt",
    label: "Pasting into the exam",
    description: "Clipboard content is pasted into an answer field.",
  },
  {
    event: "cut_attempt",
    label: "Cutting exam content",
    description: "Text on the exam page is cut to the clipboard.",
  },
  {
    event: "contextmenu",
    label: "Right-click menu",
    description: "The browser's right-click context menu is opened.",
  },
  {
    event: "camera_lost",
    label: "Camera feed lost",
    description: "The webcam stream stops or is blocked mid-session.",
  },
  {
    event: "no_face_detected",
    label: "No face visible",
    description:
      "Debounced over several consecutive snapshots. A soft signal — low light and darker skin tones both reduce detector recall, so this is never proof on its own.",
  },
  {
    event: "multiple_faces_detected",
    label: "Multiple faces detected",
    description: "A webcam snapshot shows two or more faces in frame.",
  },
  {
    event: "display_configuration_changed",
    label: "Display configuration changed",
    description:
      "A second display is plugged in (HDMI/VGA/dock), unplugged, or resized/rearranged after the session already started.",
  },
  {
    event: "concurrent_session_detected",
    label: "Concurrent session",
    description: "A second proctored session for the same exam is started while one is still active.",
  },
  {
    event: "identity_mismatch",
    label: "Identity mismatch",
    description: "The entered index number differs from the student's registry record.",
  },
  {
    event: "connection_lost",
    label: "Connection lost",
    description: "The student's browser goes offline mid-session.",
    fairnessNote:
      "Counts by default. Recommended: disable for exams where students use mobile data — network drops are often outside the student's control and can collide with the autosave/resume-on-disconnect design otherwise.",
  },
];

const SEVERITY_OPTIONS: ProctorSeverity[] = ["info", "low", "medium", "high"];

function defaultsFor(event: ProctorEvent): { severity: ProctorSeverity; counts: boolean } {
  // Mirrors default_violation_policy() exactly (20260705000004_violation_policy.sql).
  switch (event) {
    case "no_face_detected":
    case "connection_lost":
      return { severity: "medium", counts: true };
    default:
      return { severity: "high", counts: true };
  }
}

export function buildDefaultPolicyState(): ViolationPolicyState {
  const state = {} as ViolationPolicyState;
  for (const def of VIOLATION_DEFS) {
    state[def.event] = defaultsFor(def.event);
  }
  return state;
}

/** Converts editor state to the partial-override shape start_proctor_session expects. */
export function policyStateToOverrides(
  state: ViolationPolicyState,
): Record<string, { severity: ProctorSeverity; counts: boolean }> {
  const overrides: Record<string, { severity: ProctorSeverity; counts: boolean }> = {};
  for (const def of VIOLATION_DEFS) {
    overrides[def.event] = state[def.event];
  }
  return overrides;
}

interface ViolationPolicyEditorProps {
  value: ViolationPolicyState;
  onChange: (next: ViolationPolicyState) => void;
}

function SeveritySelect({
  id,
  value,
  onChange,
  disabled,
}: {
  id: string;
  value: ProctorSeverity;
  onChange: (severity: ProctorSeverity) => void;
  disabled?: boolean;
}) {
  return (
    <select
      id={id}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value as ProctorSeverity)}
      className={cn(
        "border-input focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
        "h-8 min-w-28 rounded-lg border bg-transparent px-2.5 py-1 text-sm outline-none transition-colors",
        "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        "dark:bg-input/30",
      )}
    >
      {SEVERITY_OPTIONS.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
  );
}

/**
 * The policy editor itself. Rendered as a collapsible section in the demo's
 * pre-session flow (see proctor-demo.tsx's "policy" phase, placed after
 * consent and before identity verification — the policy must be settled
 * before start_proctor_session is called, which happens right after
 * identity verification). Every row defaults to the server's policy
 * (counts=true, severity per default_violation_policy()) so a lecturer who
 * changes nothing gets exactly the "students are supposed to stay on the
 * screen and just answer the questions" default the platform ships with.
 */
export function ViolationPolicyEditor({ value, onChange }: ViolationPolicyEditorProps) {
  const [resetKey, setResetKey] = useState(0);
  const headingId = useId();

  const defaults = useMemo(() => buildDefaultPolicyState(), []);

  function updateRow(event: ProctorEvent, patch: Partial<{ severity: ProctorSeverity; counts: boolean }>) {
    onChange({ ...value, [event]: { ...value[event], ...patch } });
  }

  function handleResetToDefaults() {
    onChange(buildDefaultPolicyState());
    setResetKey((key) => key + 1);
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle id={headingId} className="flex items-center gap-2 text-base">
              <ListChecks aria-hidden className="text-primary size-4" />
              Violation policy
            </CardTitle>
            <CardDescription className="text-xs">
              Configure which events count toward the 3-strike termination and at what severity.
              By default, every violation below counts — students are expected to stay on the exam
              screen and answer the questions.
            </CardDescription>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={handleResetToDefaults}>
            <RotateCcw aria-hidden />
            Reset to defaults
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[36rem] border-collapse text-sm" key={resetKey}>
            <caption className="sr-only">
              Violation policy: for each event, whether it counts toward the 3-strike limit and its
              severity.
            </caption>
            <thead>
              <tr className="border-b text-left">
                <th scope="col" className="py-2 pr-3 font-medium">
                  Event
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Counts toward termination
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Severity
                </th>
              </tr>
            </thead>
            <tbody>
              {VIOLATION_DEFS.map((def) => {
                const rowState = value[def.event] ?? defaults[def.event];
                const toggleId = `policy-counts-${def.event}`;
                const descId = `policy-desc-${def.event}`;
                const isNonDefault =
                  rowState.severity !== defaults[def.event].severity ||
                  rowState.counts !== defaults[def.event].counts;
                return (
                  <tr key={def.event} className="border-b last:border-b-0">
                    <td className="py-3 pr-3 align-top">
                      <p className="font-medium">{def.label}</p>
                      <p id={descId} className="text-muted-foreground mt-0.5 max-w-sm text-xs">
                        {def.description}
                      </p>
                      {def.fairnessNote ? (
                        <p className="text-muted-foreground mt-1.5 flex items-start gap-1.5 max-w-sm text-xs">
                          <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                          {def.fairnessNote}
                        </p>
                      ) : null}
                    </td>
                    <td className="py-3 pr-3 align-top">
                      <div className="flex items-center gap-2">
                        <Checkbox
                          id={toggleId}
                          checked={rowState.counts}
                          aria-describedby={descId}
                          onCheckedChange={(checked) =>
                            updateRow(def.event, { counts: checked === true })
                          }
                        />
                        <Label htmlFor={toggleId} className="text-sm font-normal">
                          {rowState.counts ? "Counts as a strike" : "Logged only"}
                        </Label>
                      </div>
                    </td>
                    <td className="py-3 pr-3 align-top">
                      <div className="flex items-center gap-2">
                        <Label htmlFor={`policy-severity-${def.event}`} className="sr-only">
                          Severity for {def.label}
                        </Label>
                        <SeveritySelect
                          id={`policy-severity-${def.event}`}
                          value={rowState.severity}
                          disabled={!rowState.counts && rowState.severity === "info"}
                          onChange={(severity) => updateRow(def.event, { severity })}
                        />
                        {isNonDefault ? (
                          <span className="text-muted-foreground text-xs">(changed)</span>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-muted-foreground mt-4 flex items-start gap-2 text-xs">
          <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          This policy is enforced server-side for the whole session — a tampered browser cannot
          under-report severity or dodge a strike once the session starts.
        </p>
      </CardContent>
    </Card>
  );
}
