import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { Profile } from "@/lib/supabase/types";

export interface AdminUserRow extends Profile {
  /** Resolved from auth.users via the service-role Admin API — profiles has no email column. Null only if the auth user lookup somehow misses (shouldn't happen for a live profile row). */
  email: string | null;
}

/**
 * Lists every profile row (readable via RLS for admin/super_admin —
 * profiles_select_admin_or_higher) merged with its auth email (readable only
 * via the service-role Admin API — auth.users is never exposed through
 * PostgREST). Server-only: the service-role client this uses throws if
 * imported into browser code (see lib/supabase/admin.ts).
 *
 * The profiles list comes from the CALLER's own authenticated client (RLS
 * still applies — a non-admin caller simply gets their own single row back,
 * same fail-safe posture as every other RLS-backed read in this app), while
 * the id -> email map is service-role only for that one lookup. This means
 * even if a future call site forgets the requireRole() gate, no more than
 * "your own profile, but with your own email attached" leaks — never
 * someone else's email — because the profiles rows themselves are still
 * RLS-scoped.
 */
export async function listUsersWithEmail(): Promise<{ users: AdminUserRow[]; error?: string }> {
  const supabase = await createClient();
  if (!supabase) {
    return { users: [], error: "Supabase is not configured in this environment." };
  }

  const { data: profiles, error: profilesError } = await supabase
    .from("profiles")
    .select("*")
    .order("created_at", { ascending: true });

  if (profilesError) {
    return { users: [], error: profilesError.message };
  }

  const admin = createAdminClient();
  if (!admin) {
    // Degrade gracefully: still show the roster, just without emails.
    return { users: (profiles ?? []).map((p) => ({ ...p, email: null })) };
  }

  const emailById = new Map<string, string | null>();
  let page = 1;
  const perPage = 200;
  // Paginate through every auth user rather than assuming they all fit in
  // one page — listUsers defaults to 50/page and this project's roster will
  // outgrow that quickly once classes are seeded.
  for (;;) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) break;
    for (const u of data.users) {
      emailById.set(u.id, u.email ?? null);
    }
    if (data.users.length < perPage) break;
    page += 1;
  }

  return {
    users: (profiles ?? []).map((p) => ({ ...p, email: emailById.get(p.id) ?? null })),
  };
}
