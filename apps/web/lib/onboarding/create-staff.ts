import { createAdminClient } from "@/lib/supabase/admin";
import { generateTempPassword } from "@/lib/onboarding/temp-password";

export interface CreateStaffUserInput {
  fullName: string;
  email: string;
  phone?: string | null;
}

export type CreateStaffUserResult =
  | { ok: true; userId: string; created: true; tempPassword: string }
  | { ok: true; userId: string; created: false; tempPassword: null }
  | { ok: false; error: string };

/**
 * Creates a new staff (lecturer/admin/super_admin) auth account for `email`
 * via the service-role Admin API, or finds the existing one if that email is
 * already registered. Mirrors `createOrFindStudent`
 * (lib/onboarding/create-student.ts) exactly, except keyed by email instead
 * of index number — `profiles` has no email column (email lives on
 * `auth.users`), so the existence check pages through `listUsers` instead of
 * a `profiles` query.
 *
 * Deliberately does NOT set `profiles.role` here: `handle_new_user`
 * (20260704000001) inserts the new profile row with the default `student`
 * role, and the caller (`createUserAccount` in
 * app/dashboard/users/actions.ts) is responsible for promoting it to the
 * requested role via the `set_user_role` RPC — through the caller's own
 * cookie-bound client, as the acting admin — so Postgres re-enforces the
 * escalation rules and writes the audit_log entry. This function only ever
 * touches the Auth admin API and the non-role `profiles` columns it's
 * allowed to set directly (full_name, phone, must_change_password), exactly
 * like createOrFindStudent's split of responsibilities.
 *
 * SECURITY: the temp password is generated here, used ONCE to set the
 * account's initial password via the admin API, and returned to the caller
 * in memory — it is never written to any table. The account is flagged
 * `must_change_password = true` so /onboarding/set-password gates the
 * staff member's very first sign-in, same as a student account.
 */
export async function createOrFindStaffUser(
  input: CreateStaffUserInput,
): Promise<CreateStaffUserResult> {
  const admin = createAdminClient();
  if (!admin) {
    return { ok: false, error: "Supabase is not configured in this environment." };
  }

  const fullName = input.fullName.trim();
  const email = input.email.trim().toLowerCase();
  const phone = input.phone?.trim() || null;

  const existingId = await findUserIdByEmail(admin, email);
  if (existingId) {
    return { ok: true, userId: existingId, created: false, tempPassword: null };
  }

  const tempPassword = generateTempPassword();

  const { data: createdUser, error: createError } = await admin.auth.admin.createUser({
    email,
    password: tempPassword,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });

  if (createError || !createdUser.user) {
    return { ok: false, error: createError?.message ?? "Could not create the account." };
  }

  const userId = createdUser.user.id;

  // handle_new_user already inserted a bare profiles row (role defaults to
  // 'student') — fill in full_name/phone/must_change_password the same way
  // createOrFindStudent does. Service-role update bypasses RLS (and, for
  // must_change_password specifically, is one of the two sanctioned writers
  // per profiles_guard_update — see 20260705000008_classes_enrollment.sql).
  const { error: updateError } = await admin
    .from("profiles")
    .update({ full_name: fullName, phone, must_change_password: true })
    .eq("id", userId);

  if (updateError) {
    return { ok: false, error: updateError.message };
  }

  return { ok: true, userId, created: true, tempPassword };
}

/**
 * Finds an existing auth.users id for `email` by paging through
 * `listUsers` (mirrors lib/admin/users.ts's `listUsersWithEmail` pagination
 * — the Admin API has no `getUserByEmail`/email-filter endpoint in this
 * supabase-js version). Bounded to this platform's actual scale (a single
 * university's staff + student roster, not a multi-tenant SaaS), so a full
 * scan per call is an acceptable cost for "no duplicate account" safety.
 */
async function findUserIdByEmail(
  admin: NonNullable<ReturnType<typeof createAdminClient>>,
  email: string,
): Promise<string | null> {
  const perPage = 200;
  for (let page = 1; ; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) return null;
    const match = data.users.find((u) => u.email?.toLowerCase() === email);
    if (match) return match.id;
    if (data.users.length < perPage) return null;
  }
}
