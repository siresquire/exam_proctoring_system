import { createClient as createSupabaseClient } from "@supabase/supabase-js";

import { getSupabaseEnv } from "@/lib/supabase/env";
import type { Database } from "@/lib/supabase/types";

/**
 * Service-role Supabase client. Bypasses RLS entirely — never import this
 * from a Client Component, never return its data straight to the browser
 * without checking it belongs to the caller, and never log the key.
 *
 * Server-only by construction, not just convention: `SUPABASE_SERVICE_ROLE_KEY`
 * has no `NEXT_PUBLIC_` prefix, so Next.js never inlines it into the client
 * bundle (see lib/supabase/env.ts's comment on that convention) — reading it
 * from `process.env` in code that somehow ended up in a Client Component
 * would just see `undefined`, not the real key. The explicit
 * `typeof window !== "undefined"` guard below is a second, defense-in-depth
 * check that throws loudly instead of silently returning null, so a stray
 * client-side import fails fast in development rather than shipping a
 * client that quietly never works.
 *
 * Used today for exactly one thing (`app/login/actions.ts`'s index-number
 * resolution — see that file for why it needs to bypass RLS): looking up
 * which auth user a `profiles.student_number` belongs to, BEFORE that user
 * has proven who they are with a password. That lookup, and the index
 * number -> email mapping it produces, must never reach the browser; only
 * the resolved email is used, server-side, to attempt the real password
 * sign-in.
 */
export function createAdminClient() {
  if (typeof window !== "undefined") {
    throw new Error("lib/supabase/admin.ts must never be imported into browser code.");
  }

  const env = getSupabaseEnv();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!env || !serviceRoleKey) return null;

  return createSupabaseClient<Database>(env.url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
