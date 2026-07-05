import { createBrowserClient } from "@supabase/ssr";

import { getSupabaseEnv } from "@/lib/supabase/env";
import type { Database } from "@/lib/supabase/types";

/**
 * Browser Supabase client (client components only — use
 * `lib/supabase/server.ts` in server components, actions, and route
 * handlers). Returns null when the env vars are missing so pages can show
 * a friendly "not configured" state instead of crashing; call sites that
 * have already checked `isSupabaseConfigured()` may use
 * `createClientOrThrow()` for a non-nullable client.
 *
 * `autoRefreshToken: false` — found while verifying the session-refresh fix:
 * `createBrowserClient` caches a SINGLETON per page (see @supabase/ssr
 * source), so its default `autoRefreshToken: true` starts exactly one
 * background timer for the tab's lifetime the first time ANY call site here
 * calls `createClient()` — including a one-shot call like the login form's
 * password submit. That timer then keeps trying to refresh in the
 * background using whatever refresh token it captured, races the SSR
 * middleware (`lib/supabase/middleware.ts`) which is ALSO refreshing on
 * every navigation, loses every time once the middleware rotates first, and
 * then retries in a tight loop — hundreds of `refresh_token_already_used`
 * requests per minute, which both wipes the session the middleware just
 * established and eventually trips GoTrue's abuse rate-limiter. The
 * middleware is the sole refresher of record for this app (every page load
 * goes through it); no call site here needs a client-side timer duplicating
 * that work, so it's disabled at the source instead of patched per call site.
 */
export function createClient() {
  const env = getSupabaseEnv();
  if (!env) return null;
  return createBrowserClient<Database>(env.url, env.anonKey, {
    auth: { autoRefreshToken: false },
  });
}

export function createClientOrThrow() {
  const client = createClient();
  if (!client) {
    throw new Error(
      "Supabase is not configured: set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY (see apps/web/.env.example).",
    );
  }
  return client;
}
