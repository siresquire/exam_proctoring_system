import { notFound } from "next/navigation";

import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { FormsExamWrapper } from "@/components/forms/forms-exam-wrapper";

/**
 * Phase 2a student wrapper entry point (PLAN.md Phase 2, task brief item 3).
 * Any authenticated role may open it — students take it for real, staff can
 * preview (requireRole with every role, though super_admin passes
 * regardless of what's listed).
 *
 * Loads the exam through the SAME cookie-bound client the RLS policies
 * apply to — forms_exams_select_published_and_open only returns a row when
 * status='published' AND now() is inside [opens_at, closes_at], and
 * forms_exams_select_owner_or_lecturer additionally lets the owner/any
 * lecturer preview a draft. A null result here therefore means "not
 * visible to you right now" for any reason (draft, closed, out-of-window,
 * or nonexistent) — the friendly 404 below deliberately does not
 * distinguish which, mirroring the sign-in form's no-enumeration posture
 * elsewhere in this codebase.
 */
export default async function FormsExamWrapperPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { profile } = await requireRole("super_admin", "admin", "lecturer", "student");
  const { id } = await params;

  const supabase = await createClient();
  const { data: exam } = supabase
    ? await supabase.from("forms_exams").select("*").eq("id", id).maybeSingle()
    : { data: null };

  if (!exam) {
    notFound();
  }

  return <FormsExamWrapper exam={exam} fullName={profile.full_name} />;
}
