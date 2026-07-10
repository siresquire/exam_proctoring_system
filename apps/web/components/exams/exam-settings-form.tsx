"use client";

import { useId, useState } from "react";
import { Save } from "lucide-react";

import { updateExam } from "@/app/dashboard/lecturer/exams/actions";
import {
  ViolationPolicyEditor,
  buildDefaultPolicyState,
  policyStateToOverrides,
  type ViolationPolicyState,
} from "@/components/proctor/violation-policy-editor";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RESULTS_RELEASE_LABELS, TIER_LABELS, fromDatetimeLocalValue, toDatetimeLocalValue } from "@/lib/exams/types";
import { notify } from "@/lib/notify";
import { cn } from "@/lib/utils";
import type { ClassRow, ExamResultsRelease, ExamRow } from "@/lib/supabase/types";

/** Mirrors forms-exam-form.tsx's policyFromStored — converts a stored jsonb blob back into editor state. */
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

interface ExamSettingsFormProps {
  exam: ExamRow;
  classes: ClassRow[];
  onSaved?: () => void;
}

/**
 * Exam-level settings: title/description, class assignment, schedule,
 * integrity tier, violation policy (reusing ViolationPolicyEditor
 * wholesale, same as forms-exam-form.tsx), shuffle toggles, results
 * release. Separate from the section editor (exam-builder.tsx) since this
 * is a plain settings form with its own save action.
 */
export function ExamSettingsForm({ exam, classes, onSaved }: ExamSettingsFormProps) {
  const titleId = useId();
  const descId = useId();
  const classIdFieldId = useId();
  const opensId = useId();
  const closesId = useId();
  const durationId = useId();
  const tierId = useId();
  const releaseId = useId();

  const [title, setTitle] = useState(exam.title);
  const [description, setDescription] = useState(exam.description ?? "");
  const [classId, setClassId] = useState(exam.class_id ?? "");
  const [opensAt, setOpensAt] = useState(toDatetimeLocalValue(exam.opens_at));
  const [closesAt, setClosesAt] = useState(toDatetimeLocalValue(exam.closes_at));
  const [durationMinutes, setDurationMinutes] = useState(exam.duration_minutes ? String(exam.duration_minutes) : "");
  const [integrityTier, setIntegrityTier] = useState(exam.integrity_tier);
  const [shuffleQuestions, setShuffleQuestions] = useState(exam.shuffle_questions);
  const [shuffleOptions, setShuffleOptions] = useState(exam.shuffle_options);
  const [resultsRelease, setResultsRelease] = useState<ExamResultsRelease>(exam.results_release);
  const [policy, setPolicy] = useState<ViolationPolicyState>(() => policyFromStored(exam.violation_policy));
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    if (!title.trim()) {
      await notify.warning("Title required", "Give this exam a title before saving.");
      return;
    }

    setSaving(true);
    try {
      const result = await updateExam({
        examId: exam.id,
        title,
        description,
        classId: classId || null,
        opensAt: fromDatetimeLocalValue(opensAt),
        closesAt: fromDatetimeLocalValue(closesAt),
        durationMinutes: durationMinutes ? Number(durationMinutes) : null,
        integrityTier,
        violationPolicy: policyStateToOverrides(policy),
        shuffleQuestions,
        shuffleOptions,
        resultsRelease,
      });
      if (result.error) {
        await notify.error("Could not save settings", result.error);
        return;
      }
      await notify.toast({ title: "Exam settings saved" });
      onSaved?.();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Exam details</CardTitle>
          <CardDescription>Title, class assignment, schedule, and duration.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor={titleId}>Title</Label>
            <Input id={titleId} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} className="min-h-11" />
          </div>
          <div className="space-y-2">
            <Label htmlFor={descId}>Description (optional)</Label>
            <Input id={descId} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} className="min-h-11" />
          </div>
          <div className="space-y-2">
            <Label htmlFor={classIdFieldId}>Class</Label>
            <select
              id={classIdFieldId}
              value={classId}
              onChange={(e) => setClassId(e.target.value)}
              className="border-input focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 h-9 w-full max-w-xl rounded-lg border bg-transparent px-2.5 py-1 text-sm outline-none transition-colors dark:bg-input/30"
            >
              <option value="">No class assigned — students cannot see this exam</option>
              {classes.map((klass) => (
                <option key={klass.id} value={klass.id}>
                  {klass.name}
                  {klass.code ? ` (${klass.code})` : ""}
                </option>
              ))}
            </select>
            <p className="text-muted-foreground text-sm">
              Only students enrolled in this class can see and take this exam.
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor={opensId}>Opens at (optional)</Label>
              <Input id={opensId} type="datetime-local" value={opensAt} onChange={(e) => setOpensAt(e.target.value)} className="min-h-11" />
            </div>
            <div className="space-y-2">
              <Label htmlFor={closesId}>Closes at (optional)</Label>
              <Input id={closesId} type="datetime-local" value={closesAt} onChange={(e) => setClosesAt(e.target.value)} className="min-h-11" />
            </div>
            <div className="space-y-2">
              <Label htmlFor={durationId}>Duration, minutes (optional)</Label>
              <Input
                id={durationId}
                type="number"
                min={1}
                inputMode="numeric"
                value={durationMinutes}
                onChange={(e) => setDurationMinutes(e.target.value)}
                className="min-h-11"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Integrity & randomization</CardTitle>
          <CardDescription>
            Per-student randomization is a core anti-cheat layer — question and option order can be
            shuffled independently for every attempt.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor={tierId}>Integrity tier</Label>
            <select
              id={tierId}
              value={integrityTier}
              onChange={(e) => setIntegrityTier(Number(e.target.value))}
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

          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">Shuffling</legend>
            <div className="flex items-center gap-2">
              <Checkbox id="shuffle-questions" checked={shuffleQuestions} onCheckedChange={(c) => setShuffleQuestions(c === true)} />
              <Label htmlFor="shuffle-questions" className="text-sm font-normal">
                Shuffle section and question order per attempt
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox id="shuffle-options" checked={shuffleOptions} onCheckedChange={(c) => setShuffleOptions(c === true)} />
              <Label htmlFor="shuffle-options" className="text-sm font-normal">
                Shuffle multiple-choice option order per attempt
              </Label>
            </div>
          </fieldset>

          <div className="space-y-2">
            <Label htmlFor={releaseId}>Results release</Label>
            <select
              id={releaseId}
              value={resultsRelease}
              onChange={(e) => setResultsRelease(e.target.value as ExamResultsRelease)}
              className="border-input focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 h-9 w-full max-w-xl rounded-lg border bg-transparent px-2.5 py-1 text-sm outline-none transition-colors dark:bg-input/30"
            >
              {Object.entries(RESULTS_RELEASE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        </CardContent>
      </Card>

      <ViolationPolicyEditor value={policy} onChange={setPolicy} />

      <div className="flex justify-end">
        <Button type="button" onClick={handleSave} disabled={saving}>
          <Save aria-hidden />
          {saving ? "Saving…" : "Save settings"}
        </Button>
      </div>
    </div>
  );
}
