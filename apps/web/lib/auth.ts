import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { User } from "@supabase/supabase-js";

import { getSupabaseEnv } from "@/lib/supabase/env";
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
 *
 * Wrapped in React `cache()` so multiple call sites in the same request tree
 * (the root layout's `SiteHeader` AND a nested dashboard layout's
 * `requireRole`, for example) share one result instead of each hitting
 * Supabase independently.
 *
 * Deliberately does NOT use the supabase-js client's `auth.getUser()` or
 * `auth.getSession()` here — found while verifying the session-refresh fix.
 * Both revalidate/refresh the JWT when the access token is near or past
 * expiry: `getUser()` explicitly, and `getSession()` "silently" via
 * `__loadSession()`'s own proactive-refresh step (it's not actually a pure
 * read despite the name). Worse, `SupabaseClient`'s query builder
 * (`.from(...)`) calls `auth.getSession()` internally too, to attach the
 * bearer token — so even avoiding the two auth methods above and going
 * straight to a query does NOT avoid this. Every one of those paths can
 * independently redeem the refresh token, and every one of them runs in
 * this Node.js Server Component render — a different isolate from
 * `lib/supabase/middleware.ts` (`proxy.ts`, Edge runtime), which is ALSO
 * refreshing on every request. Two isolates, N redemption attempts,
 * ONE single-use refresh token: reproduced empirically as repeated
 * `Invalid Refresh Token: Already Used`, wiping a perfectly valid session.
 *
 * The fix: read the access token straight out of the request cookie
 * (`readAccessTokenFromCookies` below decodes the same JSON
 * `@supabase/ssr` writes) and validate it locally by checking its `exp`
 * claim — no network call, no SDK auth method, no redemption, full stop.
 * This is safe specifically because this function is NOT the security
 * boundary — it's used for UI routing only (which dashboard to show); RLS
 * re-validates every actual data access against Postgres regardless of
 * what this returns (see `requireRole`'s doc comment). The profile lookup
 * below uses a plain `fetch` against PostgREST with that same token as an
 * explicit bearer header, bypassing the query-builder's internal
 * `getSession()` call for the same reason.
 */
export const getSessionProfile = cache(async (): Promise<SessionProfile | null> => {
  const env = getSupabaseEnv();
  if (!env) return null;

  const token = await readAccessTokenFromCookies();
  if (!token) return null;

  const user = decodeUserFromAccessToken(token);
  if (!user) return null;

  const profile = await fetchProfile(env, token, user.id);
  if (!profile) return null;

  return { user, profile };
});

interface StoredSession {
  access_token?: string;
  expires_at?: number;
}

/**
 * Reads the `@supabase/ssr` session cookie(s) directly via `next/headers`
 * and returns the access token, or null if there's no session, it's
 * malformed, or it's past its `expires_at`. Mirrors the cookie format
 * `@supabase/ssr`'s `createStorageFromOptions` writes (see
 * node_modules/@supabase/ssr/dist/main/cookies.js): a `sb-<ref>-auth-token`
 * cookie (optionally chunked across `.0`, `.1`, ... suffixes for large
 * sessions) holding `base64-` + base64url(JSON.stringify(session)).
 */
async function readAccessTokenFromCookies(): Promise<string | null> {
  const cookieStore = await cookies();
  const chunks = cookieStore
    .getAll()
    .filter((c) => c.name.includes("-auth-token"))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => c.value)
    .join("");
  if (!chunks) return null;

  const raw = chunks.startsWith("base64-") ? chunks.slice("base64-".length) : chunks;
  let session: StoredSession;
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    session = JSON.parse(json);
  } catch {
    return null;
  }

  if (!session.access_token) return null;
  if (session.expires_at && session.expires_at * 1000 <= Date.now()) {
    // Expired in the cookie we can see. Middleware refreshes on every
    // request, so by the time a Server Component runs, either the cookie
    // is already current (this branch won't be hit) or the refresh is
    // still in flight for this same request and the NEXT request will see
    // the new cookie. Treating this as signed-out for THIS render is
    // correct and avoids redeeming anything ourselves.
    return null;
  }
  return session.access_token;
}

/** Decodes the `sub`/`email` claims out of a JWT without verifying its signature — acceptable here since this is UI routing, not the security boundary (see getSessionProfile's doc comment). */
function decodeUserFromAccessToken(accessToken: string): User | null {
  const payloadSegment = accessToken.split(".")[1];
  if (!payloadSegment) return null;
  try {
    const claims = JSON.parse(Buffer.from(payloadSegment, "base64url").toString("utf8"));
    if (!claims.sub) return null;
    // Cast: only the fields getSessionProfile's callers actually read
    // (id, email) are populated; this is not a full User object.
    return { id: claims.sub, email: claims.email ?? null } as User;
  } catch {
    return null;
  }
}

/** Looks up the profile row via a plain PostgREST fetch with an explicit bearer token, bypassing supabase-js's query builder (see getSessionProfile's doc comment for why). */
async function fetchProfile(
  env: NonNullable<ReturnType<typeof getSupabaseEnv>>,
  accessToken: string,
  userId: string,
): Promise<Profile | null> {
  const res = await fetch(`${env.url}/rest/v1/profiles?id=eq.${userId}&select=*`, {
    headers: {
      apikey: env.anonKey,
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.pgrst.object+json",
    },
    cache: "no-store",
  });
  if (!res.ok) return null;
  return (await res.json()) as Profile;
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
