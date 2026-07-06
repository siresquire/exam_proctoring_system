"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2 } from "lucide-react";

import { finalizeAttemptGrade, gradeEssaySlot } from "@/app/dashboard/lecturer/exams/actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { notify } from "@/lib/notify";
import type { AttemptGradingQuestion } from "@/lib/supabase/types";

interface EssayGradeFieldProps {
  attemptId: string;
  question: AttemptGradingQuestion;
}

/** One essay slot: prompt + rubric (lecturer-only) + the student's response + an accessible marks input + feedback. */
function EssayGradeField({ attemptId, question }: EssayGradeFieldProps) {
  const [marks, setMarks] = useState(question.marks_awarded != null ? String(question.marks_awarded) : "");
  const [feedback, setFeedback] = useState(question.feedback ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(question.marks_awarded != null);

  const marksId = useId();
  const feedbackId = useId();
  const responseText =
    question.response && typeof question.response === "object" && "text" in question.response
      ? String((question.response as { text?: string }).text ?? "")
      : "";

  async function handleSave() {
    const numeric = Number(marks);
    if (marks.trim() === "" || Number.isNaN(numeric)) {
      await notify.warning("Marks required", "Enter a number of marks between 0 and the maximum.");
      return;
    }
    if (numeric < 0 || numeric > question.max) {
      await notify.warning("Marks out of range", `Enter a value between 0 and ${question.max}.`);
      return;
    }

    setSaving(true);
    const result = await gradeEssaySlot(attemptId, question.question_ref, numeric, feedback);
    setSaving(false);

    if (result.error) {
      await notify.error("Could not save grade", result.error);
      return;
    }

    setSaved(true);
    await notify.toast({ title: "Grade saved" });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{question.prompt}</CardTitle>
        <CardDescription>Worth {question.max} marks.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {question.rubric ? (
          <div className="bg-secondary/40 rounded-md border p-3 text-sm">
            <p className="mb-1 font-medium">Rubric (visible to you only)</p>
            <p className="text-muted-foreground whitespace-pre-wrap">{String(question.rubric)}</p>
          </div>
        ) : null}

        <div>
          <p className="mb-1 text-sm font-medium">Student&apos;s answer</p>
          <div className="rounded-md border p-3 text-sm whitespace-pre-wrap">
            {responseText || <span className="text-muted-foreground">No answer submitted.</span>}
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-[8rem_1fr]">
          <div className="space-y-2">
            <Label htmlFor={marksId}>Marks (0–{question.max})</Label>
            <input
              id={marksId}
              type="number"
              inputMode="decimal"
              min={0}
              max={question.max}
              value={marks}
              onChange={(event) => {
                setMarks(event.target.value);
                setSaved(false);
              }}
              className="border-input focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 h-11 w-full rounded-lg border bg-transparent px-3 text-base outline-none transition-colors"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={feedbackId}>Feedback (optional)</Label>
            <textarea
              id={feedbackId}
              value={feedback}
              onChange={(event) => {
                setFeedback(event.target.value);
                setSaved(false);
              }}
              rows={3}
              className="border-input focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 w-full rounded-lg border bg-transparent px-3 py-2 text-base outline-none transition-colors"
              placeholder="Optional comments for the student"
            />
          </div>
        </div>
      </CardContent>
      <CardFooter className="justify-between">
        {saved ? (
          <p role="status" className="text-muted-foreground flex items-center gap-1.5 text-sm">
            <CheckCircle2 aria-hidden className="size-4" />
            Saved
          </p>
        ) : (
          <span />
        )}
        <Button onClick={handleSave} disabled={saving}>
          {saving ? "Saving…" : "Save grade"}
        </Button>
      </CardFooter>
    </Card>
  );
}

interface EssayGradingFormProps {
  attemptId: string;
  examId: string;
  essayQuestions: AttemptGradingQuestion[];
  alreadyGraded: boolean;
}

/**
 * Phase 3d-ii manual essay grading UI: one EssayGradeField per essay slot in
 * the attempt, plus a "Finalize grade" action. grade_essay_slot
 * auto-finalizes once every essay has a grade (see the migration), so this
 * button mainly matters for the "leave one essay ungraded at 0" case, or
 * simply to make the state change explicit for the lecturer.
 */
export function EssayGradingForm({ attemptId, examId, essayQuestions, alreadyGraded }: EssayGradingFormProps) {
  const router = useRouter();
  const [finalizing, setFinalizing] = useState(false);

  async function handleFinalize() {
    const confirmed = await notify.confirm({
      title: "Finalize this attempt's grade?",
      text: "Any essay slot without a saved grade will count as 0 marks. This recomputes the total score.",
      confirmButtonText: "Finalize",
    });
    if (!confirmed) return;

    setFinalizing(true);
    const result = await finalizeAttemptGrade(attemptId);
    setFinalizing(false);

    if (result.error) {
      await notify.error("Could not finalize grade", result.error);
      return;
    }

    await notify.success("Grade finalized", "The total score has been recomputed.");
    router.push(`/dashboard/lecturer/exams/${examId}/results`);
  }

  if (essayQuestions.length === 0) {
    return <p className="text-muted-foreground text-sm">This attempt has no essay questions to grade.</p>;
  }

  return (
    <div className="space-y-6">
      {essayQuestions.map((question) => (
        <EssayGradeField key={question.question_ref} attemptId={attemptId} question={question} />
      ))}
      <div className="flex justify-end">
        <Button onClick={handleFinalize} disabled={finalizing} variant={alreadyGraded ? "outline" : "default"}>
          {finalizing ? "Finalizing…" : alreadyGraded ? "Re-finalize grade" : "Finalize grade"}
        </Button>
      </div>
    </div>
  );
}
