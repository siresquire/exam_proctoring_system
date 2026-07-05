import { notFound } from "next/navigation";

import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { FormsExamResultsTable } from "@/components/forms/forms-exam-results-table";
import type { FormsExamSessionRow } from "@/lib/supabase/types";

export default async function FormsExamResultsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireRole("lecturer", "admin");
  const { id } = await params;

  const supabase = await createClient();
  if (!supabase) {
    notFound();
  }

  const { data: exam } = await supabase.from("forms_exams").select("*").eq("id", id).maybeSingle();
  if (!exam) {
    notFound();
  }

  const { data, error } = await supabase.rpc("forms_exam_sessions", { forms_exam_id: id });
  const sessions: FormsExamSessionRow[] = error ? [] : (data ?? []);

  return (
    <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Results — {exam.title}</h1>
        <p className="text-muted-foreground mt-2 max-w-2xl">
          Every proctored session started against this quiz&apos;s student link. A flagged report
          means the session hit its violation limit and is pending human review (Phase 4 builds
          the review workspace; for now, treat a report as a prompt to check the event history in
          Studio before deciding anything).
        </p>
      </header>
      {error ? (
        <p className="text-destructive text-sm">Could not load results: {error.message}</p>
      ) : (
        <FormsExamResultsTable sessions={sessions} />
      )}
    </div>
  );
}
