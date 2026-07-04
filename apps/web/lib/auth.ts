import { redirect } from "next/navigation";
import type { User } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/server";
import type { Profile, UserRole } from "@/lib/supabase/types";

/** Where each role lands after login (and when visiting /dashboard). */
export const DASHBOARD_BY_ROLE: Record<UserRole, string> = {
  super_admin: "/dashboard/super-admin",
  admin: "/dashboard/admin",
  lecturer: "/dashboard/lecturer",
  student: "/dashboard/student",
};

export interface SessionProfile {
  user: User;
  profile: Profile;
}

/**
 * Reads the current session and its profile row server-side. Returns null
 * when signed out, when Supabase isn't configured, or when the profile row
 * is missing (shouldn't happen — handle_new_user creates it on signup).
 */
export async function getSessionProfile(): Promise<SessionProfile | null> {
  const supabase = await createClient();
  if (!supabase) return null;

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: profile } = await supabase.from("profiles").select("*").eq("id", user.id).single();
  if (!profile) return null;

  return { user, profile };
}

/**
 * Server-side role gate for dashboard layouts. UI-level only — RLS in
 * Postgres is the actual security boundary; this just keeps users on the
 * screens meant for them.
 *
 * - Unauthenticated (or Supabase unconfigured) -> redirect to /login.
 * - super_admin passes EVERY check (universal role — it can act as
 *   admin/lecturer/student anywhere, mirroring public.has_role() in SQL).
 * - Any other role not in `roles` -> redirect to that user's own dashboard.
 */
export async function requireRole(...roles: UserRole[]): Promise<SessionProfile> {
  const session = await getSessionProfile();
  if (!session) redirect("/login");

  const { role } = session.profile;
  if (role !== "super_admin" && !roles.includes(role)) {
    redirect(DASHBOARD_BY_ROLE[role]);
  }

  return session;
}
