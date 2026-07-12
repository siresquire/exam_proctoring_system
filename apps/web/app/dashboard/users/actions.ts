"use server";

import { revalidatePath } from "next/cache";

import { requireRole } from "@/lib/auth";
import { canActOnAccountRole } from "@/lib/admin/role-labels";
import { createOrFindStaffUser } from "@/lib/onboarding/create-staff";
import { createOrFindStudent } from "@/lib/onboarding/create-student";
import { regenerateTempPassword } from "@/lib/onboarding/regenerate-password";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { Json, ProfileStatus, UserRole } from "@/lib/supabase/types";

const USERS_PATH = "/dashboard/users";

export interface ActionResult {
  error?: string;
}

/**
 * Changes a user's role. Thin wrapper around the set_user_role RPC — every
 * escalation rule (nobody self-changes, only super_admin grants admin/
 * super_admin, admin may only set lecturer/student) is enforced in Postgres
 * (supabase/migrations/20260704000005_rls_policies.sql), NOT here. This
 * function exists only to run under requireRole and revalidate the page;
 * it never touches profiles.role directly.
 */
export async function changeUserRole(targetId: string, newRole: UserRole): Promise<ActionResult> {
  await requireRole("admin", "super_admin");

  const supabase = await createClient();
  if (!supabase) {
    return { error: "Supabase is not configured in this environment." };
  }

  const { error } = await supabase.rpc("set_user_role", { target: targetId, new_role: newRole });
  if (error) {
    return { error: error.message };
  }

  revalidatePath(USERS_PATH);
  return {};
}

export interface AccommodationsInput {
  extraTimeMultiplier: number | null;
  suppressAtFlags: boolean;
  notes: string;
}

/**
 * Updates a user's accommodations (DESIGN.md §3: extra-time multiplier,
 * AT-flag suppression, reviewer notes). Goes through the caller's own
 * authenticated client so RLS (profiles_update_admin_or_higher +
 * profiles_guard_update) is the actual enforcement: an admin/super_admin
 * may set accommodations on any row, but the same trigger still blocks
 * full_name/student_number/role from changing via this path.
 */
export async function updateAccommodations(
  targetId: string,
  input: AccommodationsInput,
): Promise<ActionResult> {
  await requireRole("admin", "super_admin");

  const supabase = await createClient();
  if (!supabase) {
    return { error: "Supabase is not configured in this environment." };
  }

  const accommodations: Json = {
    ...(input.extraTimeMultiplier !== null ? { extra_time_multiplier: input.extraTimeMultiplier } : {}),
    suppress_at_flags: input.suppressAtFlags,
    notes: input.notes.trim(),
  };

  const { error } = await supabase.from("profiles").update({ accommodations }).eq("id", targetId);
  if (error) {
    return { error: error.message };
  }

  revalidatePath(USERS_PATH);
  return {};
}

const INDEX_NUMBER_PATTERN = /^\d{10}$/;
const EMAIL_PATTERN = /^\S+@\S+\.\S+$/;

/**
 * Which roles a caller with `callerRole` may create directly, mirroring
 * `set_user_role`'s escalation rules exactly (supabase/migrations/
 * 20260704000005_rls_policies.sql): admin -> lecturer/student only;
 * super_admin -> any of the four. There is no "target's current role" here
 * (unlike set_user_role, which also considers the target's OLD role) because
 * creation always starts from a brand-new account with no prior role.
 */
const CREATABLE_ROLES: Record<"admin" | "super_admin", UserRole[]> = {
  admin: ["student", "lecturer"],
  super_admin: ["student", "lecturer", "admin", "super_admin"],
};

export interface CreateUserAccountInput {
  fullName: string;
  role: UserRole;
  /** Required (10 digits) when role === "student". */
  indexNumber?: string;
  /** Required (email) when role !== "student". */
  email?: string;
  phone?: string | null;
}

export interface CreateUserAccountResult {
  error?: string;
  userId?: string;
  /** Only present when `created` is true — shown to the caller exactly once, never persisted. */
  tempPassword?: string;
  /** False means an account for this email/index number already existed and nothing new was created. */
  created?: boolean;
}

/**
 * Creates a new account with a caller-chosen role — the admin-console
 * counterpart to the class-roster import path (which only ever creates
 * students). requireRole gates this to admin/super_admin, but the actual
 * security boundary is the escalation check immediately below: it runs
 * BEFORE any account is created, and mirrors — deliberately redundantly —
 * the exact rule `set_user_role` enforces in Postgres, so an admin cannot
 * create an admin/super_admin account by any request-crafting (skipping the
 * UI, calling this action directly with a forged `role`, etc.). Even if
 * this in-app check were somehow bypassed, the role assignment for staff
 * accounts below still goes through the `set_user_role` RPC — never a
 * direct `profiles.role` write — so Postgres re-enforces the same rule a
 * second time and audit-logs the outcome either way.
 *
 * - role === "student": requires a 10-digit index number; reuses
 *   `createOrFindStudent` (the same primitive the roster importer and
 *   "Add student" dialog use) — the synthesized `<index>@students.usted.local`
 *   email, temp password, and `must_change_password = true` all come from
 *   there. `handle_new_user` already assigns the default `student` role, so
 *   no `set_user_role` call is needed for this branch.
 * - role !== "student" (lecturer/admin/super_admin): requires a real email;
 *   `createOrFindStaffUser` (lib/onboarding/create-staff.ts) creates the
 *   Auth user + temp password + `must_change_password = true`, then — only
 *   for a freshly created account — this function calls `set_user_role`
 *   through the CALLER's own cookie-bound client so the RPC runs as the
 *   acting admin (escalation re-check + audit_log entry with the real
 *   actor_id).
 *
 * If the email/index number already has an account, nothing new is
 * created (or role-changed) — the result reports `created: false` so the
 * caller can say "this account already exists" instead of silently
 * duplicating or silently reassigning someone else's role.
 */
export async function createUserAccount(
  input: CreateUserAccountInput,
): Promise<CreateUserAccountResult> {
  const session = await requireRole("admin", "super_admin");

  const fullName = input.fullName.trim();
  if (!fullName) {
    return { error: "Full name is required." };
  }

  // Escalation check FIRST — before touching the Admin API or any table.
  // session.profile.role is guaranteed to be "admin" or "super_admin" here:
  // requireRole redirects (and never returns) for every other role.
  const callerRole = session.profile.role as "admin" | "super_admin";
  const allowedRoles = CREATABLE_ROLES[callerRole];
  if (!allowedRoles.includes(input.role)) {
    return {
      error: `You are not allowed to create a ${input.role.replace("_", " ")} account.`,
    };
  }

  if (input.role === "student") {
    const indexNumber = (input.indexNumber ?? "").trim();
    if (!INDEX_NUMBER_PATTERN.test(indexNumber)) {
      return { error: "Enter a valid 10-digit index number." };
    }

    const result = await createOrFindStudent({
      fullName,
      indexNumber,
      phone: input.phone,
    });
    if (!result.ok) {
      return { error: result.error };
    }

    revalidatePath(USERS_PATH);
    return {
      userId: result.studentId,
      created: result.created,
      tempPassword: result.created ? result.tempPassword : undefined,
    };
  }

  // Staff (lecturer/admin/super_admin): needs a real email.
  const email = (input.email ?? "").trim();
  if (!EMAIL_PATTERN.test(email)) {
    return { error: "Enter a valid email address." };
  }

  const staffResult = await createOrFindStaffUser({ fullName, email, phone: input.phone });
  if (!staffResult.ok) {
    return { error: staffResult.error };
  }

  if (!staffResult.created) {
    // Existing account — report it without touching its role. Changing an
    // existing person's role is what the Users & roles table's role <select>
    // (changeUserRole above) is for; silently reassigning it here, from a
    // "create" action, would be surprising and is not what was asked for.
    revalidatePath(USERS_PATH);
    return { userId: staffResult.userId, created: false };
  }

  // Newly created staff account: promote it from the handle_new_user
  // default ('student') to the requested role via the sanctioned RPC, as
  // the CALLER (not the service role) — set_user_role re-validates the
  // exact escalation rule checked above and audit-logs {actor: this admin,
  // target: the new user, old_role: 'student', new_role: input.role}.
  const supabase = await createClient();
  if (!supabase) {
    return { error: "Supabase is not configured in this environment." };
  }

  const { error: roleError } = await supabase.rpc("set_user_role", {
    target: staffResult.userId,
    new_role: input.role,
  });
  if (roleError) {
    return {
      error: `Account created, but its role could not be set: ${roleError.message}`,
    };
  }

  revalidatePath(USERS_PATH);
  return {
    userId: staffResult.userId,
    created: true,
    tempPassword: staffResult.tempPassword,
  };
}

const CLASSES_PATH = "/dashboard/lecturer/classes";

/**
 * Changes an account's lifecycle status (active/suspended/removed). Thin
 * wrapper around the `set_account_status` RPC — the entire permission
 * matrix (super_admin -> admin/lecturer/student; admin -> lecturer/student;
 * lecturer -> student ONLY if enrolled in a class the lecturer owns; nobody
 * acts on self or an equal/higher role) is enforced in Postgres
 * (supabase/migrations/20260711000001_account_lifecycle.sql), NOT here —
 * this function only gates "signed in as lecturer-or-higher" and
 * revalidates the two pages that render account actions: the Users & roles
 * table (admin/super_admin) and a lecturer's own class roster
 * (components/onboarding/class-detail.tsx), which is why the allowed-roles
 * list here is broader than this file's other admin-only actions.
 */
export async function setAccountStatus(
  targetId: string,
  newStatus: ProfileStatus,
): Promise<ActionResult> {
  await requireRole("lecturer", "admin", "super_admin");

  const supabase = await createClient();
  if (!supabase) {
    return { error: "Supabase is not configured in this environment." };
  }

  const { error } = await supabase.rpc("set_account_status", {
    target_user_id: targetId,
    new_status: newStatus,
  });
  if (error) {
    return { error: error.message };
  }

  revalidatePath(USERS_PATH);
  revalidatePath(CLASSES_PATH);
  return {};
}

export interface ResetPasswordResult {
  error?: string;
  /** Present only on success — shown to the caller exactly once, never persisted. */
  tempPassword?: string;
}

/**
 * Reset-on-demand: issues a FRESH temp password for an existing account and
 * forces a password change on the account's next sign-in
 * (`must_change_password = true`). This is the owner-decided replacement for
 * "email a reset link" — the platform never stores a plaintext password, so
 * there is nothing to recover; a super_admin/admin re-sets it instead, hands
 * the new temp password to the account holder out of band, and the account
 * is forced through /onboarding/set-password on next login, exactly like a
 * brand-new account.
 *
 * Admin/super_admin only, gated by the SAME escalation matrix as
 * `setAccountStatus`/`permanentlyDeleteAccount` (`canActOnAccountRole` —
 * lib/admin/role-labels.ts, which itself mirrors `set_account_status`'s SQL
 * rules): super_admin may reset admin/lecturer/student; admin may reset
 * lecturer/student only; nobody resets their own account or an equal/higher
 * role. Unlike setAccountStatus, there is no RPC backing this specific
 * operation (setting an Auth user's password is only available through the
 * service-role Admin API, which has no RLS to fall back on), so this
 * in-app check — re-derived from the target's CURRENT role, read fresh from
 * `profiles` right before acting, not trusted from client input — is the
 * entire security boundary. It runs, and the audit entry is written, BEFORE
 * the privileged Admin API call, mirroring permanentlyDeleteAccount's
 * ordering below so a failed audit write can never leave an unaudited
 * password change behind.
 *
 * Reuses `regenerateTempPassword` (lib/onboarding/regenerate-password.ts) —
 * the same primitive the lecturer class-roster's "Regenerate password"
 * action uses for students — since nothing about it is actually
 * student-specific: it just re-sets an Auth user's password via
 * `updateUserById` and flips `must_change_password`. The new password is
 * generated fresh, set directly via the service-role Admin API, and
 * returned to the caller in memory ONLY — never written to any table, and
 * never included in the audit metadata (the audit entry records that a
 * reset happened, not what the new password is).
 */
export async function resetUserPassword(targetUserId: string): Promise<ResetPasswordResult> {
  const session = await requireRole("admin", "super_admin");

  if (targetUserId === session.user.id) {
    return { error: "You cannot reset your own password this way." };
  }

  const admin = createAdminClient();
  if (!admin) {
    return { error: "Supabase is not configured in this environment." };
  }

  const { data: target, error: targetError } = await admin
    .from("profiles")
    .select("role")
    .eq("id", targetUserId)
    .maybeSingle();
  if (targetError || !target) {
    return { error: "Account not found." };
  }

  const callerRole = session.profile.role as UserRole;
  if (!canActOnAccountRole(callerRole, target.role)) {
    return { error: "You are not allowed to reset this account's password." };
  }

  const { error: auditError } = await admin.rpc("log_audit", {
    action: "reset_password",
    target_type: "profile",
    target_id: targetUserId,
    metadata: {},
  });
  if (auditError) {
    return { error: `Could not record the audit entry — password was NOT reset: ${auditError.message}` };
  }

  const result = await regenerateTempPassword(targetUserId);
  if (!result.ok) {
    return { error: result.error };
  }

  revalidatePath(USERS_PATH);
  return { tempPassword: result.tempPassword };
}

/**
 * Permanently (hard) deletes an account — super_admin only, and NOT
 * offered for another super_admin or the caller's own account (mirrors
 * set_account_status's "never self, never an equal/higher role" rule,
 * re-checked here independently since this path never goes through that
 * RPC). Audit-logged BEFORE the delete happens (via the service-role
 * client's `log_audit` RPC — the only role log_audit grants EXECUTE to),
 * so the record survives even though the target row it references is about
 * to be gone. `admin.auth.admin.deleteUser` cascades: profiles (FK
 * `references auth.users (id) on delete cascade`), and from there
 * exam_attempts/class_members/proctor_sessions/etc. via their own FKs.
 *
 * Uses the service-role client throughout — deleting an auth.users row is
 * an Admin API operation, not something any RLS-scoped client can do — but
 * every check that decides WHETHER to delete (role gate, self/target
 * checks) happens before the service-role client is ever touched.
 */
export async function permanentlyDeleteAccount(targetId: string): Promise<ActionResult> {
  const session = await requireRole("super_admin");

  if (targetId === session.user.id) {
    return { error: "You cannot permanently delete your own account." };
  }

  const admin = createAdminClient();
  if (!admin) {
    return { error: "Supabase is not configured in this environment." };
  }

  const { data: target, error: targetError } = await admin
    .from("profiles")
    .select("role, full_name")
    .eq("id", targetId)
    .maybeSingle();
  if (targetError || !target) {
    return { error: "Account not found." };
  }
  if (target.role === "super_admin") {
    return { error: "A super admin account cannot be permanently deleted." };
  }

  const { error: auditError } = await admin.rpc("log_audit", {
    action: "permanently_delete_account",
    target_type: "profile",
    target_id: targetId,
    metadata: { role: target.role, full_name: target.full_name },
  });
  if (auditError) {
    return { error: `Could not record the audit entry — account was NOT deleted: ${auditError.message}` };
  }

  const { error: deleteError } = await admin.auth.admin.deleteUser(targetId);
  if (deleteError) {
    return { error: deleteError.message };
  }

  revalidatePath(USERS_PATH);
  return {};
}
