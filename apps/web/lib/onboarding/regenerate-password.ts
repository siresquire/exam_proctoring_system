import { createAdminClient } from "@/lib/supabase/admin";
import { generateTempPassword } from "@/lib/onboarding/temp-password";

export type RegenerateTempPasswordResult =
  | { ok: true; tempPassword: string }
  | { ok: false; error: string };

/**
 * Re-issues a fresh temp password for an existing student account (e.g. the
 * roster export was lost, or a phone/SMS delivery failed) via the Auth
 * admin API's `updateUserById`. Re-sets `must_change_password = true` so
 * the student is forced through /onboarding/set-password again on next
 * sign-in, exactly like a newly created account.
 *
 * Caller (the server action in
 * app/dashboard/lecturer/classes/actions.ts) is responsible for the
 * lecturer/admin role check — this function does the privileged admin-API
 * call and profile update only, mirroring createOrFindStudent's split of
 * responsibilities.
 */
export async function regenerateTempPassword(studentId: string): Promise<RegenerateTempPasswordResult> {
  const admin = createAdminClient();
  if (!admin) {
    return { ok: false, error: "Supabase is not configured in this environment." };
  }

  const tempPassword = generateTempPassword();

  const { error: updateAuthError } = await admin.auth.admin.updateUserById(studentId, {
    password: tempPassword,
  });
  if (updateAuthError) {
    return { ok: false, error: updateAuthError.message };
  }

  const { error: updateProfileError } = await admin
    .from("profiles")
    .update({ must_change_password: true })
    .eq("id", studentId);
  if (updateProfileError) {
    return { ok: false, error: updateProfileError.message };
  }

  return { ok: true, tempPassword };
}
