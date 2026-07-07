import Link from "next/link";
import { notFound } from "next/navigation";

import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Breadcrumbs } from "@/components/layout/breadcrumbs";
import { Button } from "@/components/ui/button";
import { EssayGradingForm } from "@/components/exams/essay-grading-form";
import type { AttemptGradingDetail, ExamResultRow, ExamRow } from "@/lib/supabase/types";

/**
 * Phase 3d-ii manual essay grading page. Loads get_attempt_for_grading
 * (owner/lecturer-or-higher only, not release-gated — see the migration
 * comment) and renders one EssayGradingForm field per essay slot. Objective
 * slots are already auto-graded and are not editable here.
 */
export default async function GradeAttemptPage({
  params,
}: {
  params: Promise<{ id: string; attemptId: string }>;
}) {
  await requireRole("lecturer", "admin");
  const { id, attemptId } = await params;

  const supabase = await createClient();
  if (!supabase) {
    notFound();
  }

  const { data: exam } = await supabase.from("exams").select("*").eq("id", id).maybeSingle<ExamRow>();
  if (!exam) {
    notFound();
  }

  const { data, error } = await supabase.rpc("get_attempt_for_grading", { attempt_id: attemptId });
  if (error || !data) {
    notFound();
  }

  const detail = data as unknown as AttemptGradingDetail;
  const essayQuestions = detail.per_question.filter((q) => q.type === "essay");
  const objectiveQuestions = detail.per_question.filter((q) => q.type !== "essay");

  // Reuses the same exam_results RPC as the results page purely to label
  // this attempt with the student's name in the breadcrumb/heading — no new
  // query surface, and get_attempt_for_grading above already proved this
  // caller may see this attempt.
  const { data: resultRows } = await supabase.rpc("exam_results", { exam_id: id });
  const studentName = ((resultRows ?? []) as ExamResultRow[]).find((r) => r.attempt_id === attemptId)?.full_name;

  return (
    <div className="mx-auto max-w-3xl space-y-8 px-4 py-10 sm:px-6">
      <Breadcrumbs
        items={[
          { label: "Dashboard", href: "/dashboard" },
          { label: "Exams", href: "/dashboard/lecturer/exams" },
          { label: exam.title, href: `/dashboard/lecturer/exams/${id}` },
          { label: "Results", href: `/dashboard/lecturer/exams/${id}/results` },
          { label: studentName ? `Grade — ${studentName}` : "Grade attempt" },
        ]}
      />
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Grade attempt — {exam.title}</h1>
          <p className="text-muted-foreground mt-2 max-w-2xl">
            Attempt status: <span className="font-medium">{detail.status.replace("_", " ")}</span>. Objective
            questions are auto-graded; grade each essay below, then finalize.
          </p>
        </div>
        <Button asChild variant="outline">
          <Link href={`/dashboard/lecturer/exams/${id}/results`}>Back to results</Link>
        </Button>
      </header>

      {objectiveQuestions.length > 0 ? (
        <section aria-labelledby="objective-heading" className="space-y-2">
          <h2 id="objective-heading" className="text-lg font-semibold tracking-tight">
            Objective questions (auto-graded)
          </h2>
          <ul className="space-y-2 text-sm">
            {objectiveQuestions.map((q) => (
              <li key={q.question_ref} className="flex items-center justify-between rounded-md border px-3 py-2">
                <span>{q.prompt}</span>
                <span className="text-muted-foreground">
                  {q.score ?? 0} / {q.max}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="essay-heading" className="space-y-4">
        <h2 id="essay-heading" className="text-lg font-semibold tracking-tight">
          Essay questions
        </h2>
        <EssayGradingForm
          attemptId={attemptId}
          examId={id}
          essayQuestions={essayQuestions}
          alreadyGraded={detail.status === "graded"}
        />
      </section>
    </div>
  );
}
