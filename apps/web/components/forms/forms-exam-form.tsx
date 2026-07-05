"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { Save } from "lucide-react";

import { createFormsExam, updateFormsExam, type FormsExamInput } from "@/app/dashboard/lecturer/forms-exams/actions";
import {
  ViolationPolicyEditor,
  buildDefaultPolicyState,
  policyStateToOverrides,
  type ViolationPolicyState,
} from "@/components/proctor/violation-policy-editor";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { normalizeGoogleFormUrl } from "@/lib/forms/google-form-url";
import { notify } from "@/lib/notify";
import type { FormsExamRow } from "@/lib/supabase/types";

const TIER_LABELS: Record<number, string> = {
  1: "T1 — Quiz (any device, server-side checks only, no camera)",
  2: "T2 — Monitored (webcam + environment signals)",
  3: "T3 — Proctored (adds fullscreen lock + tab/app-switch detection)",
  4: "T4 — High stakes (desktop + Safe Exam Browser, not yet wired up here)",
};

function toDatetimeLocalValue(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromDatetimeLocalValue(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

/** Converts a stored forms_exams.violation_policy jsonb blob back into editor state, falling back to defaults for any event not present in the stored value (e.g. rows created before a new violation type existed). */
function policyFromStored(stored: unknown): ViolationPolicyState {
  const defaults = buildDefaultPolicyState();
  if (!stored || typeof stored !== "object") return defaults;
  const merged = { ...defaults } as ViolationPolicyState;
  for (const key of Object.keys(merged)) {
    const entry = (stored as Record<string, unknown>)[key];
    if (entry && typeof entry === "object") {
      const e = entry as { severity?: string; counts?: boolean };
      merged[key as keyof ViolationPolicyState] = {
        severity: (e.severity as ViolationPolicyState[keyof ViolationPolicyState]["severity"]) ?? defaults[key as keyof ViolationPolicyState].severity,
        counts: typeof e.counts === "boolean" ? e.counts : defaults[key as keyof ViolationPolicyState].counts,
      };
    }
  }
  return merged;
}

interface FormsExamFormProps {
  /** Present when editing an existing draft; omitted when creating a new one. */
  existing?: FormsExamRow;
}

/**
 * The lecturer's Forms-quiz builder (PLAN.md Phase 2, task brief item 2).
 * Reuses ViolationPolicyEditor wholesale — the same component the demo's
 * pre-session flow uses — so the lecturer configures exactly the same
 * per-event severity/counts policy, snapshotted onto forms_exams and, from
 * there, onto every session start_forms_exam_session creates. Saves as
 * draft; publishing is a separate explicit action on the list page (so a
 * lecturer can save partial work without immediately exposing it to
 * students — forms_exams RLS never lets students see a draft regardless).
 */
export function FormsExamForm({ existing }: FormsExamFormProps) {
  const router = useRouter();
  const titleId = useId();
  const urlId = useId();
  const tierId = useId();
  const opensId = useId();
  const closesId = useId();
  const durationId = useId();

  const [title, setTitle] = useState(existing?.title ?? "");
  const [googleFormUrl, setGoogleFormUrl] = useState(existing?.google_form_url ?? "");
  const [urlError, setUrlError] = useState<string | null>(null);
  const [integrityTier, setIntegrityTier] = useState(existing?.integrity_tier ?? 2);
  const [opensAt, setOpensAt] = useState(toDatetimeLocalValue(existing?.opens_at ?? null));
  const [closesAt, setClosesAt] = useState(toDatetimeLocalValue(existing?.closes_at ?? null));
  const [durationMinutes, setDurationMinutes] = useState(
    existing?.duration_minutes ? String(existing.duration_minutes) : "",
  );
  const [policy, setPolicy] = useState<ViolationPolicyState>(() =>
    existing ? policyFromStored(existing.violation_policy) : buildDefaultPolicyState(),
  );
  const [saving, setSaving] = useState(false);

  function validateUrl(value: string): boolean {
    const result = normalizeGoogleFormUrl(value);
    setUrlError(result.ok ? null : (result.error ?? "Invalid URL."));
    return result.ok;
  }

  async function handleSave() {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      await notify.warning("Title required", "Give this quiz a title before saving.");
      return;
    }
    if (!validateUrl(googleFormUrl)) {
      await notify.warning("Invalid Google Form URL", urlError ?? "Check the form link and try again.");
      return;
    }

    const input: FormsExamInput = {
      title: trimmedTitle,
      googleFormUrl,
      integrityTier,
      violationPolicy: policyStateToOverrides(policy),
      opensAt: fromDatetimeLocalValue(opensAt),
      closesAt: fromDatetimeLocalValue(closesAt),
      durationMinutes: durationMinutes ? Number(durationMinutes) : null,
    };

    setSaving(true);
    try {
      const result = existing
        ? await updateFormsExam(existing.id, input)
        : await createFormsExam(input);
      if (result.error) {
        await notify.error("Could not save", result.error);
        return;
      }
      await notify.success("Saved", "Your Forms quiz has been saved as a draft.");
      router.push("/dashboard/lecturer/forms-exams");
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Quiz details</CardTitle>
          <CardDescription>
            The Google Form itself is unchanged — we only wrap it with monitoring. Make sure the
            form is set to &quot;Anyone with the link can respond&quot; so it can be embedded (see
            the note below).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor={titleId}>Title</Label>
            <Input
              id={titleId}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={200}
              placeholder="Week 4 quiz — Data Structures"
              className="min-h-11"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor={urlId}>Google Form link</Label>
            <Input
              id={urlId}
              value={googleFormUrl}
              onChange={(event) => {
                setGoogleFormUrl(event.target.value);
                if (urlError) setUrlError(null);
              }}
              onBlur={(event) => validateUrl(event.target.value)}
              inputMode="url"
              placeholder="https://docs.google.com/forms/d/e/1FAIpQ.../viewform"
              aria-invalid={Boolean(urlError)}
              aria-describedby={urlError ? `${urlId}-error` : `${urlId}-help`}
              className="min-h-11 font-mono text-sm"
            />
            {urlError ? (
              <p id={`${urlId}-error`} className="text-destructive text-sm">
                {urlError}
              </p>
            ) : (
              <p id={`${urlId}-help`} className="text-muted-foreground text-sm">
                In Google Forms, click Send, choose the link icon, and paste that URL here. We
                normalize it for embedding automatically.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor={tierId}>Integrity tier</Label>
            <select
              id={tierId}
              value={integrityTier}
              onChange={(event) => setIntegrityTier(Number(event.target.value))}
              className={cn(
                "border-input focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
                "h-9 w-full max-w-xl rounded-lg border bg-transparent px-2.5 py-1 text-sm outline-none transition-colors",
                "dark:bg-input/30",
              )}
            >
              {[1, 2, 3, 4].map((tier) => (
                <option key={tier} value={tier}>
                  {TIER_LABELS[tier]}
                </option>
              ))}
            </select>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor={opensId}>Opens at (optional)</Label>
              <Input
                id={opensId}
                type="datetime-local"
                value={opensAt}
                onChange={(event) => setOpensAt(event.target.value)}
                className="min-h-11"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={closesId}>Closes at (optional)</Label>
              <Input
                id={closesId}
                type="datetime-local"
                value={closesAt}
                onChange={(event) => setClosesAt(event.target.value)}
                className="min-h-11"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={durationId}>Duration, minutes (optional)</Label>
              <Input
                id={durationId}
                type="number"
                min={1}
                inputMode="numeric"
                value={durationMinutes}
                onChange={(event) => setDurationMinutes(event.target.value)}
                className="min-h-11"
              />
            </div>
          </div>
          <p className="text-muted-foreground text-sm">
            Duration is informational for now (shown to students) — the wrapper does not yet
            auto-submit when time runs out; the student ends their own session with &quot;I have
            submitted the form&quot;.
          </p>
        </CardContent>
      </Card>

      <ViolationPolicyEditor value={policy} onChange={setPolicy} />

      <div className="flex justify-end gap-3">
        <Button type="button" variant="outline" onClick={() => router.back()}>
          Cancel
        </Button>
        <Button type="button" onClick={handleSave} disabled={saving}>
          <Save aria-hidden />
          {saving ? "Saving…" : "Save as draft"}
        </Button>
      </div>
    </div>
  );
}
