import type { UserRole } from "@/lib/supabase/types";

/** Shared display labels for the four roles — used by the Users & roles table, its role <select>, and the Create-user dialog, so all three stay in sync. */
export const ROLE_LABELS: Record<UserRole, string> = {
  super_admin: "Super admin",
  admin: "Admin",
  lecturer: "Lecturer",
  student: "Student",
};

export const ALL_ROLES: UserRole[] = ["super_admin", "admin", "lecturer", "student"];
