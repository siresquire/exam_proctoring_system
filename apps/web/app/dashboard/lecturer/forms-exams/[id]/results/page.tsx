import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { FormsBypassDetectionPanel } from "@/components/forms/forms-bypass-detection-panel";
import { FormsExamResultsTable } from "@/components/forms/forms-exam-results-table";
import { FormsExamSubmissionsTable } from "@/components/forms/forms-exam-submissions-table";
import type { FormsExamSessionRow, FormsExamSubmissionRow } from "@/lib/supabase/types";

/** Derives the current deployment's origin from request headers, so the Apps Script config panel shows a working absolute webhook URL in any environment (local, preview, production) without a hardcoded env var. */
async function currentOrigin(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

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

  const { data: submissionsData, error: submissionsError } = await supabase.rpc(
    "forms_exam_submissions",
    { forms_exam_id: id },
  );
  const submissions: FormsExamSubmissionRow[] = submissionsError ? [] : (submissionsData ?? []);

  const webhookOrigin = await currentOrigin();

  return (
    <div className="mx-auto max-w-5xl space-y-10 px-4 py-10 sm:px-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Results — {exam.title}</h1>
        <p className="text-muted-foreground mt-2 max-w-2xl">
          Every proctored session started against this quiz&apos;s student link. A flagged report
          means the session hit its violation limit and is pending human review (Phase 4 builds
          the review workspace; for now, treat a report as a prompt to check the event history in
          Studio before deciding anything).
        </p>
      </header>

      <section aria-labelledby="sessions-heading" className="space-y-4">
        <h2 id="sessions-heading" className="text-lg font-semibold tracking-tight">
          Proctored sessions
        </h2>
        {error ? (
          <p className="text-destructive text-sm">Could not load results: {error.message}</p>
        ) : (
          <FormsExamResultsTable sessions={sessions} />
        )}
      </section>

      <section aria-labelledby="bypass-heading" className="space-y-4">
        <h2 id="bypass-heading" className="text-lg font-semibold tracking-tight">
          Bypass detection
        </h2>
        <FormsBypassDetectionPanel
          formsExamId={id}
          webhookOrigin={webhookOrigin}
          hasSecret={Boolean(exam.submission_secret)}
        />
        {submissionsError ? (
          <p className="text-destructive text-sm">
            Could not load submissions: {submissionsError.message}
          </p>
        ) : (
          <FormsExamSubmissionsTable submissions={submissions} />
        )}
      </section>
    </div>
  );
}
