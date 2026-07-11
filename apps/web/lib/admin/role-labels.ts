import type { UserRole } from "@/lib/supabase/types";

/** Shared display labels for the four roles — used by the Users & roles table, its role <select>, and the Create-user dialog, so all three stay in sync. */
export const ROLE_LABELS: Record<UserRole, string> = {
  super_admin: "Super admin",
  admin: "Admin",
  lecturer: "Lecturer",
  student: "Student",
};

export const ALL_ROLES: UserRole[] = ["super_admin", "admin", "lecturer", "student"];

/**
 * Role-only slice of the account-lifecycle permission matrix, mirroring
 * `set_account_status` (supabase/migrations/20260711000001_account_lifecycle.sql)
 * exactly like `assignableRoles` in users-table.tsx mirrors `set_user_role`:
 * super_admin may act on admin/lecturer/student; admin may act on
 * lecturer/student; lecturer may act on student only. Never an equal or
 * higher role.
 *
 * This encodes only the ROLE axis of the matrix — callers must ALSO check
 * "not self" (nobody acts on their own account) and, for a lecturer acting
 * on a student, "the student is enrolled in a class the lecturer owns"
 * (the RPC is the real enforcement for both; this is UI gating only, shared
 * by the Users & roles table and the class roster so neither ever renders a
 * control the RPC would reject).
 */
export function canActOnAccountRole(viewerRole: UserRole, targetRole: UserRole): boolean {
  if (viewerRole === "super_admin") return targetRole !== "super_admin";
  if (viewerRole === "admin") return targetRole === "lecturer" || targetRole === "student";
  if (viewerRole === "lecturer") return targetRole === "student";
  return false;
}
