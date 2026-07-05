import { createAdminClient } from "@/lib/supabase/admin";
import { generateTempPassword } from "@/lib/onboarding/temp-password";
import { studentEmailForIndex } from "@/lib/onboarding/student-email";

export interface CreateOrFindStudentInput {
  fullName: string;
  indexNumber: string;
  phone?: string | null;
}

export type CreateOrFindStudentResult =
  | { ok: true; studentId: string; created: true; tempPassword: string }
  | { ok: true; studentId: string; created: false; tempPassword: null }
  | { ok: false; error: string };

/**
 * Creates a new student account for `indexNumber` (via the service-role Auth
 * admin API — never from browser code, see lib/supabase/admin.ts's guard),
 * or finds the existing one if `profiles.student_number` already matches.
 *
 * SECURITY: the temp password is generated here, used ONCE to set the
 * account's initial password via the admin API, and returned to the caller
 * in memory — it is never written to any table. The account is flagged
 * `must_change_password = true` so /onboarding/set-password gates the
 * student's very first sign-in. If the caller loses the returned value
 * (e.g. a crashed import midway through), the only recovery path is
 * `regenerateTempPassword()` (lib/onboarding/regenerate-password.ts) — by
 * design, there is no "look it up again" path, because that would mean it
 * was stored.
 *
 * Idempotent by index number: calling this twice for the same indexNumber
 * returns `created: false` and `tempPassword: null` the second time, rather
 * than erroring or creating a duplicate account — this is what lets a
 * lecturer re-run the same CSV import (e.g. after fixing a typo in one row)
 * without re-issuing every other student a new password.
 */
export async function createOrFindStudent(
  input: CreateOrFindStudentInput,
): Promise<CreateOrFindStudentResult> {
  const admin = createAdminClient();
  if (!admin) {
    return { ok: false, error: "Supabase is not configured in this environment." };
  }

  const fullName = input.fullName.trim();
  const indexNumber = input.indexNumber.trim();
  const phone = input.phone?.trim() || null;

  const { data: existingProfile, error: lookupError } = await admin
    .from("profiles")
    .select("id")
    .eq("student_number", indexNumber)
    .maybeSingle();

  if (lookupError) {
    return { ok: false, error: lookupError.message };
  }

  if (existingProfile) {
    return { ok: true, studentId: existingProfile.id, created: false, tempPassword: null };
  }

  const email = studentEmailForIndex(indexNumber);
  const tempPassword = generateTempPassword();

  const { data: createdUser, error: createError } = await admin.auth.admin.createUser({
    email,
    password: tempPassword,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });

  if (createError || !createdUser.user) {
    return { ok: false, error: createError?.message ?? "Could not create the student account." };
  }

  const studentId = createdUser.user.id;

  // handle_new_user (20260704000001) already inserted a bare profiles row
  // (role defaults to 'student', which is what we want) — fill in the
  // registry fields the trigger has no way to know: student_number, phone,
  // and the must_change_password flag. Service-role update bypasses RLS
  // (and, for must_change_password specifically, is one of the two
  // sanctioned writers per profiles_guard_update — see the migration).
  const { error: updateError } = await admin
    .from("profiles")
    .update({
      full_name: fullName,
      student_number: indexNumber,
      phone,
      must_change_password: true,
    })
    .eq("id", studentId);

  if (updateError) {
    return { ok: false, error: updateError.message };
  }

  return { ok: true, studentId, created: true, tempPassword };
}
