import Link from "next/link";
import { notFound } from "next/navigation";

import { fetchExamResults } from "@/app/dashboard/lecturer/exams/actions";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Breadcrumbs } from "@/components/layout/breadcrumbs";
import { Button } from "@/components/ui/button";
import { ExamResultsTable } from "@/components/exams/exam-results-table";
import { ReleaseResultsButton } from "@/components/exams/release-results-button";
import { BarChartCard } from "@/components/charts/bar-chart-card";
import { bucketScoreDistribution } from "@/lib/exams/score-distribution";
import type { ExamRow } from "@/lib/supabase/types";

const RELEASE_LABEL: Record<string, string> = {
  immediate: "Immediate — students see their result as soon as they submit.",
  after_close: "After the exam closes — students see results once the exam is closed or its window ends.",
  manual: "Manual — results are hidden until you release them below.",
};

/**
 * Phase 3d-ii lecturer exam-results page: per-attempt grading state + an
 * integrity summary (violation count, session status, whether a
 * proctor_report exists) via exam_results(). Not the Phase 4 review
 * workspace — see the components' comments for what's deliberately out of
 * scope here (video timeline, per-flag verdicts, appeals).
 */
export default async function ExamResultsPage({ params }: { params: Promise<{ id: string }> }) {
  await requireRole("lecturer", "admin");
  const { id } = await params;

  const supabase = await createClient();
  if (!supabase) {
    notFound();
  }

  const { data: exam } = await supabase.from("exams").select("*").eq("id", id).maybeSingle<ExamRow>();
  if (!exam) {
    notFound();
  }

  const { rows, error } = await fetchExamResults(id);

  return (
    <div className="mx-auto max-w-5xl space-y-8 px-4 py-10 sm:px-6">
      <Breadcrumbs
        items={[
          { label: "Dashboard", href: "/dashboard" },
          { label: "Exams", href: "/dashboard/lecturer/exams" },
          { label: exam.title, href: `/dashboard/lecturer/exams/${id}` },
          { label: "Results" },
        ]}
      />
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Results — {exam.title}</h1>
          <p className="text-muted-foreground mt-2 max-w-2xl">
            {RELEASE_LABEL[exam.results_release] ?? exam.results_release}
          </p>
        </div>
        <div className="flex gap-2">
          {exam.results_release === "manual" ? (
            <ReleaseResultsButton examId={id} alreadyReleased={Boolean(exam.results_released_at)} />
          ) : null}
          <Button asChild variant="outline">
            <Link href={`/dashboard/lecturer/exams/${id}`}>Back to exam</Link>
          </Button>
        </div>
      </header>

      {rows && rows.length > 0 ? (
        <BarChartCard
          title="Score distribution"
          description="Fully-graded attempts, bucketed by percentage of max score."
          data={bucketScoreDistribution(rows)}
          valueLabel="Attempts"
          emptyMessage="No fully-graded attempts yet."
        />
      ) : null}

      <section aria-labelledby="attempts-heading" className="space-y-4">
        <h2 id="attempts-heading" className="text-lg font-semibold tracking-tight">
          Attempts
        </h2>
        {error ? (
          <p className="text-destructive text-sm">Could not load results: {error}</p>
        ) : (
          <ExamResultsTable examId={id} rows={rows ?? []} />
        )}
      </section>
    </div>
  );
}
