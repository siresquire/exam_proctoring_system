import { notFound } from "next/navigation";

import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { ExamAttemptWrapper } from "@/components/exam-room/exam-attempt-wrapper";

/**
 * Phase 3d-i student exam-taking entry point. Mirrors app/exam/forms/[id]'s
 * pattern: load the exam through the cookie-bound client so RLS itself
 * decides visibility (exams_select_published_open_enrolled requires
 * published + in-window + class_members enrollment; exams_select_owner_or_
 * lecturer additionally lets staff preview) — a null result here means "not
 * visible to you right now" for any reason, surfaced as a plain 404 rather
 * than distinguishing which (same no-enumeration posture as the rest of the
 * app).
 *
 * Only a student takes it for real; staff roles may open it to preview the
 * intro screen (they will not be enrolled in class_members and so cannot
 * actually start an attempt — start_exam_attempt re-checks enrollment
 * server-side regardless of what this page renders).
 */
export default async function ExamAttemptPage({ params }: { params: Promise<{ examId: string }> }) {
  const { profile } = await requireRole("super_admin", "admin", "lecturer", "student");
  const { examId } = await params;

  const supabase = await createClient();
  const { data: exam } = supabase
    ? await supabase.from("exams").select("*").eq("id", examId).maybeSingle()
    : { data: null };

  if (!exam) {
    notFound();
  }

  return (
    <ExamAttemptWrapper exam={exam} studentNumber={profile.student_number} fullName={profile.full_name} />
  );
}
