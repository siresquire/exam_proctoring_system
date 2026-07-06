import { notFound } from "next/navigation";

import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { AttemptResultView } from "@/components/exams/attempt-result-view";
import type { AttemptResult, ExamRow } from "@/lib/supabase/types";

/**
 * Phase 3d-ii student result page. Loads the attempt's own exam title (via
 * the owner-or-manager SELECT policy on exam_attempts + exams) purely for
 * display, then calls the release-gated get_attempt_result RPC — the ONE
 * place a correct answer may ever reach a student, and only once released.
 */
export default async function AttemptResultPage({
  params,
}: {
  params: Promise<{ attemptId: string }>;
}) {
  const { profile } = await requireRole("super_admin", "admin", "lecturer", "student");
  const { attemptId } = await params;

  const supabase = await createClient();
  if (!supabase) {
    notFound();
  }

  const { data: attempt } = await supabase
    .from("exam_attempts")
    .select("id, exam_id, student_id")
    .eq("id", attemptId)
    .maybeSingle();

  if (!attempt || attempt.student_id !== profile.id) {
    // Not visible to this caller under RLS, or belongs to someone else —
    // same no-enumeration posture as the rest of the app: a plain 404
    // either way.
    notFound();
  }

  const { data: exam } = await supabase.from("exams").select("*").eq("id", attempt.exam_id).maybeSingle<ExamRow>();
  if (!exam) {
    notFound();
  }

  const { data, error } = await supabase.rpc("get_attempt_result", { attempt_id: attemptId });
  if (error || !data) {
    notFound();
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <AttemptResultView examTitle={exam.title} result={data as unknown as AttemptResult} />
    </div>
  );
}
