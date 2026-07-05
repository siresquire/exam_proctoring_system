import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

import { getSupabaseEnv } from "@/lib/supabase/env";
import { withRefreshLock } from "@/lib/supabase/refresh-lock";
import type { Database } from "@/lib/supabase/types";

function authCookieKey(getAll: () => { name: string; value: string }[]): string | null {
  // Mirrors lib/supabase/middleware.ts's key derivation exactly — both must
  // key `withRefreshLock` identically so the two independent refresh call
  // sites (this client and the SSR middleware) can actually collide on the
  // same lock instead of each getting their own. See refresh-lock.ts.
  const relevant = getAll().filter((c) => c.name.includes("-auth-token"));
  if (relevant.length === 0) return null;
  return relevant.map((c) => `${c.name}=${c.value}`).join("&");
}

/**
 * Server Supabase client for server components, server actions, and route
 * handlers. A fresh client per request (never a module-level singleton) —
 * it carries the caller's cookie-bound session.
 *
 * Returns null when the env vars are missing (fresh clone / CI build with
 * no Supabase project yet) so callers can degrade gracefully.
 *
 * `auth.getUser()` is monkey-patched below to go through the same
 * refresh-lock as the SSR middleware, as a defensive safety net for any
 * future caller that needs the fully-revalidated user (see
 * lib/supabase/refresh-lock.ts). In practice `lib/auth.ts#getSessionProfile`
 * — the main consumer of this client — deliberately calls `getSession()`
 * instead, precisely because that lock can't fully close the race between
 * this (Node.js runtime) and the middleware (Edge runtime): see
 * getSessionProfile's doc comment for why a non-mutating read is correct
 * there. New server-side call sites should prefer the same pattern (trust
 * the middleware to have refreshed already; read, don't redeem) unless they
 * specifically need `getUser()`'s server-side revalidation.
 */
export async function createClient() {
  const env = getSupabaseEnv();
  if (!env) return null;

  const cookieStore = await cookies();
  const lockKey = authCookieKey(() => cookieStore.getAll());

  const client = createServerClient<Database>(env.url, env.anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Called from a Server Component, where Next.js forbids cookie
          // writes. Safe to ignore: the middleware (updateSession) refreshes
          // sessions, so the write happens there instead.
        }
      },
    },
  });

  // Monkey-patch just the one call that can trigger a mutating refresh, so
  // every other use of this client (queries, RLS-scoped requests, etc.) is
  // untouched. See refresh-lock.ts for the "why".
  const originalGetUser = client.auth.getUser.bind(client.auth);
  client.auth.getUser = ((...args: Parameters<typeof originalGetUser>) =>
    withRefreshLock(lockKey, () => originalGetUser(...args))) as typeof originalGetUser;

  return client;
}
