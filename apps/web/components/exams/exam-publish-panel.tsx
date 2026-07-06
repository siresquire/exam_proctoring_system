"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, Eye, Loader2, Rocket, XCircle } from "lucide-react";

import { previewExamDraw, setExamStatus, validateExam } from "@/app/dashboard/lecturer/exams/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { drawTotals } from "@/lib/exams/types";
import { notify } from "@/lib/notify";
import type { ExamDraw, ExamRow, ExamValidationResult } from "@/lib/supabase/types";

interface ExamPublishPanelProps {
  exam: ExamRow;
}

const STATUS_BADGE_VARIANT: Record<string, "secondary" | "outline" | "destructive"> = {
  draft: "outline",
  published: "secondary",
  closed: "destructive",
};

/**
 * Validate / Preview / Publish controls (task brief item 2). Validation
 * issues are rendered as an accessible error summary (list with role="alert"
 * region), not just a toast, since a lecturer may need to read several
 * issues at once before fixing them.
 */
export function ExamPublishPanel({ exam }: ExamPublishPanelProps) {
  const router = useRouter();
  const [validation, setValidation] = useState<ExamValidationResult | null>(null);
  const [validating, setValidating] = useState(false);
  const [draw, setDraw] = useState<ExamDraw | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [publishing, setPublishing] = useState(false);

  async function handleValidate() {
    setValidating(true);
    try {
      const result = await validateExam(exam.id);
      if (result.error) {
        await notify.error("Could not validate", result.error);
        return;
      }
      setValidation(result.result ?? null);
      if (result.result?.ok) {
        await notify.toast({ title: "Exam is ready to publish" });
      }
    } finally {
      setValidating(false);
    }
  }

  async function handlePreview() {
    setPreviewing(true);
    try {
      const result = await previewExamDraw(exam.id);
      if (result.error) {
        await notify.error("Could not preview", result.error);
        return;
      }
      setDraw(result.draw ?? null);
    } finally {
      setPreviewing(false);
    }
  }

  async function handlePublish() {
    setPublishing(true);
    try {
      const result = await setExamStatus(exam.id, "published");
      if (result.error) {
        await notify.error("Cannot publish", result.error);
        return;
      }
      await notify.success("Exam published", "Enrolled students will see it once the window opens.");
      router.refresh();
    } finally {
      setPublishing(false);
    }
  }

  async function handleUnpublish(target: "draft" | "closed") {
    const confirmed = await notify.confirm({
      title: target === "closed" ? "Close this exam?" : "Revert to draft?",
      text:
        target === "closed"
          ? "Students will no longer be able to see or start this exam."
          : "The exam will no longer be visible to students until republished.",
    });
    if (!confirmed) return;

    const result = await setExamStatus(exam.id, target);
    if (result.error) {
      await notify.error("Could not update status", result.error);
      return;
    }
    await notify.toast({ title: `Exam ${target === "closed" ? "closed" : "reverted to draft"}` });
    router.refresh();
  }

  const totals = drawTotals(draw);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="text-lg">Publish</CardTitle>
              <CardDescription>Validate the exam, preview a sample paper, then publish.</CardDescription>
            </div>
            <Badge variant={STATUS_BADGE_VARIANT[exam.status] ?? "outline"} className="text-sm">
              {exam.status}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-3">
            <Button type="button" variant="outline" onClick={handleValidate} disabled={validating}>
              {validating ? <Loader2 aria-hidden className="animate-spin" /> : <CheckCircle2 aria-hidden />}
              {validating ? "Validating…" : "Validate"}
            </Button>
            <Button type="button" variant="outline" onClick={handlePreview} disabled={previewing}>
              {previewing ? <Loader2 aria-hidden className="animate-spin" /> : <Eye aria-hidden />}
              {previewing ? "Drawing sample…" : "Preview sample paper"}
            </Button>
            {exam.status === "draft" ? (
              <Button type="button" onClick={handlePublish} disabled={publishing}>
                <Rocket aria-hidden />
                {publishing ? "Publishing…" : "Publish"}
              </Button>
            ) : exam.status === "published" ? (
              <>
                <Button type="button" variant="outline" onClick={() => handleUnpublish("draft")}>
                  Revert to draft
                </Button>
                <Button type="button" variant="destructive" onClick={() => handleUnpublish("closed")}>
                  Close exam
                </Button>
              </>
            ) : (
              <Button type="button" variant="outline" onClick={() => handleUnpublish("draft")}>
                Reopen as draft
              </Button>
            )}
          </div>

          {validation ? (
            <div role="status" aria-live="polite">
              {validation.ok ? (
                <p className="text-sm font-medium text-green-700 dark:text-green-400">
                  <CheckCircle2 aria-hidden className="mr-1.5 inline size-4" />
                  This exam is ready to publish.
                </p>
              ) : (
                <div role="alert" className="border-destructive/50 bg-destructive/5 rounded-lg border p-4">
                  <p className="text-destructive flex items-center gap-1.5 text-sm font-medium">
                    <AlertTriangle aria-hidden className="size-4" />
                    {validation.issues.length} issue{validation.issues.length === 1 ? "" : "s"} must be fixed before publishing
                  </p>
                  <ul className="mt-2 list-inside list-disc space-y-1 text-sm">
                    {validation.issues.map((issue, i) => (
                      <li key={i}>{issue}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : null}
        </CardContent>
      </Card>

      {draw ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Sample paper preview</CardTitle>
            <CardDescription>
              {totals.questionCount} question{totals.questionCount === 1 ? "" : "s"}, {totals.totalMarks} mark
              {totals.totalMarks === 1 ? "" : "s"} total. This is one possible draw — pool sources pick a new
              random sample each time you preview, exactly like a new student attempt would.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {draw.sections.map((section) => (
              <div key={section.section_id}>
                <h3 className="font-medium">{section.title}</h3>
                <ol className="mt-2 space-y-2">
                  {section.questions.map((q, i) => (
                    <li key={q.version_id} className="bg-muted/30 rounded-lg border px-3 py-2 text-sm">
                      <span className="text-muted-foreground mr-2">{i + 1}.</span>
                      {q.prompt}
                    </li>
                  ))}
                  {section.questions.length === 0 ? (
                    <li className="text-muted-foreground flex items-center gap-1.5 text-sm">
                      <XCircle aria-hidden className="size-4" />
                      No questions resolved for this section — check its sources.
                    </li>
                  ) : null}
                </ol>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
