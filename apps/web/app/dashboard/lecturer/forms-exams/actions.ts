"use server";

import { revalidatePath } from "next/cache";

import { requireRole } from "@/lib/auth";
import { normalizeGoogleFormUrl } from "@/lib/forms/google-form-url";
import { createClient } from "@/lib/supabase/server";
import type { Json } from "@/lib/supabase/types";

export interface FormsExamActionResult {
  error?: string;
  id?: string;
}

const FORMS_EXAMS_PATH = "/dashboard/lecturer/forms-exams";

export interface FormsExamInput {
  title: string;
  googleFormUrl: string;
  integrityTier: number;
  violationPolicy: Record<string, { severity: string; counts: boolean }>;
  opensAt: string | null;
  closesAt: string | null;
  durationMinutes: number | null;
}

/**
 * Shared validation for create/update — re-runs the same checks the
 * builder form already did client-side, because a server action must never
 * trust the client (DESIGN.md, and the same posture as start_proctor_session's
 * server-side violation_policy validation). Returns either the normalized
 * fields ready for the database, or an error string.
 */
function validateInput(
  input: FormsExamInput,
): { ok: true; title: string; googleFormUrl: string; integrityTier: number } | { ok: false; error: string } {
  const title = input.title.trim();
  if (!title) {
    return { ok: false, error: "Title is required." };
  }
  if (title.length > 200) {
    return { ok: false, error: "Title must be 200 characters or fewer." };
  }

  const normalized = normalizeGoogleFormUrl(input.googleFormUrl);
  if (!normalized.ok || !normalized.url) {
    return { ok: false, error: normalized.error ?? "Invalid Google Form URL." };
  }

  const tier = Math.round(input.integrityTier);
  if (!Number.isFinite(tier) || tier < 1 || tier > 4) {
    return { ok: false, error: "Integrity tier must be between 1 and 4." };
  }

  return { ok: true, title, googleFormUrl: normalized.url, integrityTier: tier };
}

export async function createFormsExam(input: FormsExamInput): Promise<FormsExamActionResult> {
  const { user } = await requireRole("lecturer", "admin");

  const validated = validateInput(input);
  if (!validated.ok) {
    return { error: validated.error };
  }

  const supabase = await createClient();
  if (!supabase) {
    return { error: "Supabase is not configured in this environment." };
  }

  const { data, error } = await supabase
    .from("forms_exams")
    .insert({
      owner_id: user.id,
      title: validated.title,
      google_form_url: validated.googleFormUrl,
      integrity_tier: validated.integrityTier,
      violation_policy: input.violationPolicy as unknown as Json,
      opens_at: input.opensAt,
      closes_at: input.closesAt,
      duration_minutes: input.durationMinutes,
    })
    .select("id")
    .single();

  if (error || !data) {
    return { error: error?.message ?? "Could not create the exam." };
  }

  revalidatePath(FORMS_EXAMS_PATH);
  return { id: data.id };
}

export async function updateFormsExam(
  id: string,
  input: FormsExamInput,
): Promise<FormsExamActionResult> {
  await requireRole("lecturer", "admin");

  const validated = validateInput(input);
  if (!validated.ok) {
    return { error: validated.error };
  }

  const supabase = await createClient();
  if (!supabase) {
    return { error: "Supabase is not configured in this environment." };
  }

  const { error } = await supabase
    .from("forms_exams")
    .update({
      title: validated.title,
      google_form_url: validated.googleFormUrl,
      integrity_tier: validated.integrityTier,
      violation_policy: input.violationPolicy as unknown as Json,
      opens_at: input.opensAt,
      closes_at: input.closesAt,
      duration_minutes: input.durationMinutes,
    })
    .eq("id", id);

  if (error) {
    return { error: error.message };
  }

  revalidatePath(FORMS_EXAMS_PATH);
  return { id };
}

export async function publishFormsExam(id: string): Promise<FormsExamActionResult> {
  await requireRole("lecturer", "admin");

  const supabase = await createClient();
  if (!supabase) {
    return { error: "Supabase is not configured in this environment." };
  }

  const { error } = await supabase.from("forms_exams").update({ status: "published" }).eq("id", id);
  if (error) {
    return { error: error.message };
  }

  revalidatePath(FORMS_EXAMS_PATH);
  return { id };
}

export async function closeFormsExam(id: string): Promise<FormsExamActionResult> {
  await requireRole("lecturer", "admin");

  const supabase = await createClient();
  if (!supabase) {
    return { error: "Supabase is not configured in this environment." };
  }

  const { error } = await supabase.from("forms_exams").update({ status: "closed" }).eq("id", id);
  if (error) {
    return { error: error.message };
  }

  revalidatePath(FORMS_EXAMS_PATH);
  return { id };
}

/** Reopens a closed exam back to draft — lets a lecturer fix a mistake without recreating the row. Published exams should use closeFormsExam, not this, to move backward. */
export async function reopenFormsExamAsDraft(id: string): Promise<FormsExamActionResult> {
  await requireRole("lecturer", "admin");

  const supabase = await createClient();
  if (!supabase) {
    return { error: "Supabase is not configured in this environment." };
  }

  const { error } = await supabase.from("forms_exams").update({ status: "draft" }).eq("id", id);
  if (error) {
    return { error: error.message };
  }

  revalidatePath(FORMS_EXAMS_PATH);
  return { id };
}

export interface RotateSecretResult {
  error?: string;
  secret?: string;
}

/**
 * Phase 2b: generates (or replaces) the per-exam shared secret the lecturer
 * pastes into their Apps Script (apps-script/forms-proctor-crosscheck.gs).
 * Delegates the actual generation + RLS-equivalent ownership check to the
 * rotate_forms_exam_secret() RPC (security definer) — this action does not
 * duplicate that check, it only re-asserts the coarse lecturer-or-higher
 * dashboard gate that guards every action in this file.
 */
export async function rotateFormsExamSecret(id: string): Promise<RotateSecretResult> {
  await requireRole("lecturer", "admin");

  const supabase = await createClient();
  if (!supabase) {
    return { error: "Supabase is not configured in this environment." };
  }

  const { data, error } = await supabase.rpc("rotate_forms_exam_secret", { forms_exam_id: id });
  if (error || !data) {
    return { error: error?.message ?? "Could not generate a secret." };
  }

  revalidatePath(`${FORMS_EXAMS_PATH}/${id}/results`);
  return { secret: data };
}
