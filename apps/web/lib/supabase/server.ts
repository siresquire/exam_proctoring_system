import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

import { getSupabaseEnv } from "@/lib/supabase/env";
import type { Database } from "@/lib/supabase/types";

/**
 * Server Supabase client for server components, server actions, and route
 * handlers. A fresh client per request (never a module-level singleton) —
 * it carries the caller's cookie-bound session.
 *
 * Returns null when the env vars are missing (fresh clone / CI build with
 * no Supabase project yet) so callers can degrade gracefully.
 */
export async function createClient() {
  const env = getSupabaseEnv();
  if (!env) return null;

  const cookieStore = await cookies();

  return createServerClient<Database>(env.url, env.anonKey, {
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
}
