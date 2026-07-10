"use server";

import { revalidatePath } from "next/cache";

import { requireRole } from "@/lib/auth";
import { createOrFindStudent } from "@/lib/onboarding/create-student";
import { regenerateTempPassword } from "@/lib/onboarding/regenerate-password";
import { parseRosterCsv, validateRosterRows, type RosterRowPreview } from "@/lib/onboarding/roster-csv";
import { getSmsProvider } from "@/lib/sms/provider";
import { createClient } from "@/lib/supabase/server";
import type { ClassRosterRow } from "@/lib/supabase/types";

const CLASSES_PATH = "/dashboard/lecturer/classes";

export interface ClassActionResult {
  error?: string;
  id?: string;
}

export async function createClass(name: string, code: string, description: string): Promise<ClassActionResult> {
  await requireRole("lecturer", "admin");

  const trimmedName = name.trim();
  if (!trimmedName) {
    return { error: "Class name is required." };
  }

  const supabase = await createClient();
  if (!supabase) {
    return { error: "Supabase is not configured in this environment." };
  }

  const { data, error } = await supabase.rpc("create_class", {
    name: trimmedName,
    code: code.trim() || null,
    description: description.trim() || null,
  });

  if (error || !data) {
    return { error: error?.message ?? "Could not create the class." };
  }

  revalidatePath(CLASSES_PATH);
  return { id: data };
}

export interface RosterPreviewResult {
  error?: string;
  rows?: RosterRowPreview[];
}

/**
 * Server-side re-parse + re-validate of the pasted/uploaded CSV text
 * (never trust the client's own parsed preview — same posture as every
 * other input in this repo). Looks up which of the file's index numbers
 * are already enrolled in this class via class_roster() (owner-or-lecturer
 * gated) so the preview can flag "already enrolled" rows before anything
 * is committed.
 */
export async function previewRosterImport(classId: string, csvText: string): Promise<RosterPreviewResult> {
  await requireRole("lecturer", "admin");

  const supabase = await createClient();
  if (!supabase) {
    return { error: "Supabase is not configured in this environment." };
  }

  const { data: roster, error: rosterError } = await supabase.rpc("class_roster", { class_id: classId });
  if (rosterError) {
    return { error: rosterError.message };
  }

  const alreadyEnrolled = new Set(
    ((roster ?? []) as ClassRosterRow[])
      .map((r) => r.student_number)
      .filter((n): n is string => Boolean(n)),
  );

  const rows = parseRosterCsv(csvText);
  return { rows: validateRosterRows(rows, alreadyEnrolled) };
}

export interface RosterImportOutcomeRow {
  fullName: string;
  indexNumber: string;
  /** Null for rows whose account already existed — no fresh password to show. */
  tempPassword: string | null;
  studentId: string;
}

export interface RosterImportResult {
  error?: string;
  imported?: RosterImportOutcomeRow[];
  skipped?: number;
}

/**
 * Commits a previously previewed import: for every row still valid at
 * commit time (re-validated here, not trusted from the client's earlier
 * preview call), creates-or-finds the student account and enrolls it into
 * the class. Collects temp passwords ONLY for accounts created new during
 * this call — existing accounts never surface a password here (see
 * createOrFindStudent's doc comment on why that value can never be
 * recovered after the fact).
 */
export async function commitRosterImport(classId: string, csvText: string): Promise<RosterImportResult> {
  await requireRole("lecturer", "admin");

  const supabase = await createClient();
  if (!supabase) {
    return { error: "Supabase is not configured in this environment." };
  }

  const { data: roster, error: rosterError } = await supabase.rpc("class_roster", { class_id: classId });
  if (rosterError) {
    return { error: rosterError.message };
  }
  const alreadyEnrolled = new Set(
    ((roster ?? []) as ClassRosterRow[])
      .map((r) => r.student_number)
      .filter((n): n is string => Boolean(n)),
  );

  const rows = parseRosterCsv(csvText);
  const validated = validateRosterRows(rows, alreadyEnrolled);

  const imported: RosterImportOutcomeRow[] = [];
  let skipped = 0;

  for (const row of validated) {
    if (row.status !== "valid") {
      skipped++;
      continue;
    }

    const result = await createOrFindStudent({
      fullName: row.fullName,
      indexNumber: row.indexNumber,
      phone: row.phone,
    });
    if (!result.ok) {
      return { error: `Row for index ${row.indexNumber}: ${result.error}` };
    }

    const { error: enrollError } = await supabase.rpc("enroll_existing_student", {
      class_id: classId,
      student_id: result.studentId,
    });
    if (enrollError) {
      return { error: `Row for index ${row.indexNumber}: ${enrollError.message}` };
    }

    imported.push({
      fullName: row.fullName,
      indexNumber: row.indexNumber,
      tempPassword: result.created ? result.tempPassword : null,
      studentId: result.studentId,
    });
  }

  revalidatePath(CLASSES_PATH);
  revalidatePath(`${CLASSES_PATH}/${classId}`);
  return { imported, skipped };
}

const INDEX_NUMBER_PATTERN = /^\d{10}$/;

export interface AddStudentFieldErrors {
  fullName?: string;
  indexNumber?: string;
}

export interface AddStudentResult {
  error?: string;
  fieldErrors?: AddStudentFieldErrors;
  studentId?: string;
  fullName?: string;
  indexNumber?: string;
  /** True only when this call created a brand-new auth account. */
  created?: boolean;
  /** True when the student was already on this class's roster before this call (no-op). */
  alreadyEnrolled?: boolean;
  /** Set ONLY when `created` is true — see createOrFindStudent's doc comment on why it can never be recovered afterward. */
  tempPassword?: string | null;
}

/**
 * Adds a single student to a class from the UI (the non-CSV path next to
 * "Import students (CSV)"). Deliberately reuses the exact same primitives as
 * commitRosterImport above, just for one row instead of a parsed file:
 * requireRole gates the caller the same way, createOrFindStudent does the
 * identical create-or-find + temp-password + must_change_password work, and
 * enroll_existing_student is the same idempotent RPC — so this path can
 * never be looser than the CSV importer's security posture.
 */
export async function addStudentToClass(
  classId: string,
  input: { fullName: string; indexNumber: string; phone?: string | null },
): Promise<AddStudentResult> {
  await requireRole("lecturer", "admin");

  const fullName = input.fullName.trim();
  const indexNumber = input.indexNumber.trim();
  const phone = input.phone?.trim() || null;

  const fieldErrors: AddStudentFieldErrors = {};
  if (!fullName) {
    fieldErrors.fullName = "Full name is required.";
  }
  if (!INDEX_NUMBER_PATTERN.test(indexNumber)) {
    fieldErrors.indexNumber = "Index number must be exactly 10 digits.";
  }
  if (Object.keys(fieldErrors).length > 0) {
    return { fieldErrors };
  }

  const supabase = await createClient();
  if (!supabase) {
    return { error: "Supabase is not configured in this environment." };
  }

  // Same "is this index already on the roster" check commitRosterImport
  // does before importing, so the UI can tell "existing account, freshly
  // enrolled" apart from "was already enrolled here — nothing changed".
  const { data: roster, error: rosterError } = await supabase.rpc("class_roster", { class_id: classId });
  if (rosterError) {
    return { error: rosterError.message };
  }
  const wasAlreadyEnrolled = ((roster ?? []) as ClassRosterRow[]).some((r) => r.student_number === indexNumber);

  const result = await createOrFindStudent({ fullName, indexNumber, phone });
  if (!result.ok) {
    return { error: result.error };
  }

  const { error: enrollError } = await supabase.rpc("enroll_existing_student", {
    class_id: classId,
    student_id: result.studentId,
  });
  if (enrollError) {
    return { error: enrollError.message };
  }

  revalidatePath(CLASSES_PATH);
  revalidatePath(`${CLASSES_PATH}/${classId}`);

  return {
    studentId: result.studentId,
    fullName,
    indexNumber,
    created: result.created,
    alreadyEnrolled: wasAlreadyEnrolled,
    tempPassword: result.created ? result.tempPassword : null,
  };
}

export interface RegeneratePasswordResult {
  error?: string;
  tempPassword?: string;
}

export async function regenerateStudentPassword(studentId: string): Promise<RegeneratePasswordResult> {
  await requireRole("lecturer", "admin");

  const result = await regenerateTempPassword(studentId);
  if (!result.ok) {
    return { error: result.error };
  }
  return { tempPassword: result.tempPassword };
}

export async function removeStudentFromClass(classId: string, studentId: string): Promise<ClassActionResult> {
  await requireRole("lecturer", "admin");

  const supabase = await createClient();
  if (!supabase) {
    return { error: "Supabase is not configured in this environment." };
  }

  const { error } = await supabase.rpc("remove_class_member", { class_id: classId, student_id: studentId });
  if (error) {
    return { error: error.message };
  }

  revalidatePath(`${CLASSES_PATH}/${classId}`);
  return {};
}

export interface SmsSendOutcome {
  indexNumber: string;
  fullName: string;
  phone: string | null;
  ok: boolean;
  detail: string;
}

export interface SmsSendResultSummary {
  error?: string;
  results?: SmsSendOutcome[];
}

/**
 * Sends (or, with the default LogSmsProvider, records) login details for a
 * set of just-imported/regenerated students. loginUrl is supplied by the
 * caller (client passes window.location.origin + "/login" — see
 * roster-export.ts's identical convention) since a server action has no
 * reliable notion of the deployment's public origin.
 */
export async function sendLoginDetailsBySms(
  classId: string,
  loginUrl: string,
  recipients: { fullName: string; indexNumber: string; phone: string | null; tempPassword: string }[],
): Promise<SmsSendResultSummary> {
  await requireRole("lecturer", "admin");

  const provider = getSmsProvider();
  const results: SmsSendOutcome[] = [];

  for (const recipient of recipients) {
    if (!recipient.phone) {
      results.push({
        indexNumber: recipient.indexNumber,
        fullName: recipient.fullName,
        phone: null,
        ok: false,
        detail: "No phone number on file.",
      });
      continue;
    }

    const message =
      `USTED exam portal: sign in at ${loginUrl} with index ${recipient.indexNumber} ` +
      `and temporary password ${recipient.tempPassword}. You will be asked to set a new password.`;

    const sendResult = await provider.send(recipient.phone, message);
    results.push({
      indexNumber: recipient.indexNumber,
      fullName: recipient.fullName,
      phone: recipient.phone,
      ok: sendResult.ok,
      detail: sendResult.ok ? (sendResult.id ?? "sent") : (sendResult.error ?? "failed"),
    });
  }

  return { results };
}
