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
 */
export function createClient() {
  const env = getSupabaseEnv();
  if (!env) return null;
  return createBrowserClient<Database>(env.url, env.anonKey);
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
