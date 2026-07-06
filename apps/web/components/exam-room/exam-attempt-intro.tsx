"use client";

import { useId, useState } from "react";
import { ClipboardCheck, Save, ShieldCheck, TimerReset } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { notify } from "@/lib/notify";
import type { ExamRow } from "@/lib/supabase/types";

const INDEX_NUMBER_PATTERN = /^\d{10}$/;

export interface ExamAttemptIntroResult {
  claimedIndexNumber: string;
  attested: true;
}

interface ExamAttemptIntroProps {
  exam: ExamRow;
  /** Prefills the index number field when the profile already has one on file (registry cross-check happens server-side, same spirit as the proctoring identity step). */
  studentNumber: string | null;
  fullName: string | null;
  onStart: (result: ExamAttemptIntroResult) => void | Promise<void>;
}

/**
 * Phase 3d-i: the short "this is a timed exam" notice + identity gate that
 * precedes start_exam_attempt. This is the T1 spine's identity step — a
 * lighter-weight sibling of proctor/identity-check.tsx (no camera/portrait,
 * since webcam proctoring is Phase 3d-ii): index number entry + the same
 * impersonation attestation wording, reused verbatim for consistency across
 * every entry point that gates on attested=true server-side.
 */
export function ExamAttemptIntro({ exam, studentNumber, fullName, onStart }: ExamAttemptIntroProps) {
  const [indexNumber, setIndexNumber] = useState(studentNumber ?? "");
  const [indexTouched, setIndexTouched] = useState(false);
  const [attested, setAttested] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const indexErrorId = useId();
  const indexHelpId = useId();

  const indexValid = INDEX_NUMBER_PATTERN.test(indexNumber);
  const indexError =
    indexTouched && !indexValid
      ? indexNumber.length === 0
        ? "Enter your 10-digit index number."
        : "Index number must be exactly 10 digits (e.g. 5201040845)."
      : null;

  const displayName = fullName?.trim() || "the account holder";
  const canStart = indexValid && attested && !submitting;

  async function handleStart() {
    setIndexTouched(true);
    if (!indexValid) {
      await notify.warning("Index number required", "Enter a valid 10-digit index number before continuing.");
      return;
    }
    if (!attested) {
      await notify.warning("Attestation required", "You must confirm the attestation statement to continue.");
      return;
    }
    setSubmitting(true);
    try {
      await onStart({ claimedIndexNumber: indexNumber, attested: true });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-xl">
            <ClipboardCheck className="text-primary" aria-hidden="true" />
            {exam.title}
          </CardTitle>
          <CardDescription>
            {exam.duration_minutes
              ? `Timed exam — ${exam.duration_minutes} minutes once you start.`
              : "Untimed exam."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <section aria-labelledby="before-heading" className="bg-secondary/40 space-y-2 rounded-md border p-3">
            <h2 id="before-heading" className="flex items-center gap-2 font-medium">
              <TimerReset aria-hidden="true" className="size-4" />
              Before you start
            </h2>
            <ul className="text-muted-foreground list-inside list-disc space-y-1 text-sm">
              <li>This is a timed exam. The countdown is tracked on our server, not your device&apos;s clock.</li>
              <li className="flex items-start gap-1.5">
                <Save aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                Your answers are saved automatically as you work — watch for the &quot;Saved&quot;
                indicator.
              </li>
              <li>Do not close this tab or navigate away. If you lose connection, reopen this page to resume exactly where you left off.</li>
              <li>You can flag questions to revisit and review your answers before final submission.</li>
            </ul>
          </section>

          <section aria-labelledby="index-heading" className="space-y-2 border-t pt-4">
            <h2 id="index-heading" className="font-medium">
              Index number
            </h2>
            <div className="space-y-2">
              <Label htmlFor="attempt-index-number">USTED index number</Label>
              <Input
                id="attempt-index-number"
                name="attempt-index-number"
                inputMode="numeric"
                pattern="\d{10}"
                maxLength={10}
                autoComplete="off"
                value={indexNumber}
                onChange={(event) => setIndexNumber(event.target.value.replace(/\D/g, "").slice(0, 10))}
                onBlur={() => setIndexTouched(true)}
                aria-invalid={Boolean(indexError)}
                aria-describedby={indexError ? `${indexErrorId} ${indexHelpId}` : indexHelpId}
                className="min-h-11 max-w-xs font-mono"
                placeholder="5201040845"
              />
              <p id={indexHelpId} className="text-muted-foreground text-sm">
                Exactly 10 digits, no spaces or letters.
              </p>
              {indexError ? (
                <p id={indexErrorId} className="text-destructive text-sm">
                  {indexError}
                </p>
              ) : null}
            </div>
          </section>

          <section aria-labelledby="attest-heading" className="space-y-3 border-t pt-4">
            <h2 id="attest-heading" className="font-medium">
              Attestation
            </h2>
            <div className="space-y-2">
              <Checkbox
                id="attempt-attestation-checkbox"
                checked={attested}
                onCheckedChange={(checked) => setAttested(checked === true)}
                aria-describedby="attempt-attestation-text"
              />
              <Label
                htmlFor="attempt-attestation-checkbox"
                id="attempt-attestation-text"
                className="block w-full text-sm font-normal leading-relaxed"
              >
                I confirm that I,{" "}
                <span className="text-primary font-semibold">{displayName}</span>, index number{" "}
                <span className="text-primary font-mono font-semibold">
                  {indexNumber || <span className="text-muted-foreground font-sans">(not yet entered)</span>}
                </span>
                , am the person taking this assessment. I understand that impersonation is an
                academic offense at USTED and may lead to cancellation of examination results,
                withdrawal from the institution, and other disciplinary measures.
              </Label>
            </div>
          </section>

          <Button type="button" className="w-full" onClick={handleStart} disabled={!canStart}>
            <ShieldCheck aria-hidden="true" />
            {submitting ? "Starting…" : "Start exam"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
