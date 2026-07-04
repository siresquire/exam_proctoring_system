import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

import { getSupabaseEnv } from "@/lib/supabase/env";
import type { Database } from "@/lib/supabase/types";

/**
 * Session refresh for every request (the @supabase/ssr "updateSession"
 * pattern). Server components can't write cookies, so without this an
 * expired access token would never be refreshed and users would be logged
 * out mid-session. Authorization itself is NOT done here — RLS is the
 * security boundary and `requireRole` handles per-dashboard gating; this
 * middleware only keeps the token fresh.
 */
export async function updateSession(request: NextRequest) {
  const env = getSupabaseEnv();
  if (!env) {
    // No Supabase project configured (fresh clone / CI) — nothing to refresh.
    return NextResponse.next({ request });
  }

  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient<Database>(env.url, env.anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        supabaseResponse = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          supabaseResponse.cookies.set(name, value, options),
        );
      },
    },
  });

  // IMPORTANT: getUser() (not getSession()) — it revalidates the JWT with
  // the auth server and triggers the refresh that this middleware exists
  // to persist. Do not remove even though the result is unused.
  await supabase.auth.getUser();

  return supabaseResponse;
}
