import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";

import { getSupabaseEnv } from "@/lib/supabase/env";
import { withRefreshLock } from "@/lib/supabase/refresh-lock";
import type { Database } from "@/lib/supabase/types";

function authCookieKey(getAll: () => { name: string; value: string }[]): string | null {
  // The @supabase/ssr client shards the session across one or more
  // `sb-<ref>-auth-token[.N]` cookies; concatenating every matching cookie's
  // raw value is enough to uniquely key the refresh token they encode,
  // without decoding the (possibly chunked, base64-prefixed) payload. Used
  // to key `withRefreshLock` — see that module for why this exists.
  const relevant = getAll().filter((c) => c.name.includes("-auth-token"));
  if (relevant.length === 0) return null;
  return relevant.map((c) => `${c.name}=${c.value}`).join("&");
}

/**
 * Session refresh for every request (the @supabase/ssr "updateSession"
 * pattern). Server components can't write cookies, so without this an
 * expired access token would never be refreshed and users would be logged
 * out mid-session. Authorization itself is NOT done here — RLS is the
 * security boundary and `requireRole` handles per-dashboard gating; this
 * middleware only keeps the token fresh.
 *
 * Wrapped in `withRefreshLock` (see lib/supabase/refresh-lock.ts), which
 * de-dupes concurrent callers *within this isolate*. That is NOT the same
 * isolate `lib/auth.ts#getSessionProfile` runs in: this middleware
 * (`proxy.ts`) executes on Next's Edge runtime, while Server Components
 * render in the Node.js runtime — two separate processes with no shared
 * memory, so the in-memory lock cannot fully prevent the two from racing to
 * redeem the same refresh token. What makes that race survivable is (a)
 * `refresh_token_reuse_interval` in supabase/config.toml, which tells GoTrue
 * to return the SAME just-rotated session (not an error) to a second
 * caller presenting the previous token within that grace window, and (b)
 * this function refusing to spend a redemption at all on requests that
 * aren't a real navigation (see the prefetch skip below) — every skipped
 * prefetch is one fewer competitor for that grace window.
 */
export async function updateSession(request: NextRequest) {
  const env = getSupabaseEnv();
  if (!env) {
    // No Supabase project configured (fresh clone / CI) — nothing to refresh.
    return NextResponse.next({ request });
  }

  // Next.js issues a flood of RSC "prefetch" requests for every <Link> that
  // scrolls into view (and again on hover) — none of them represent a user
  // actually navigating. Each one used to run the full getUser()/refresh
  // dance below, so a single visit to a page with a handful of nav links
  // could fire a dozen+ concurrent refresh-token redemptions, guaranteeing
  // `refresh_token_already_used` races and even tripping GoTrue's abuse
  // rate-limiter. Prefetch requests carry this header (see Next.js router
  // source); skipping the refresh for them is safe because the token is
  // still valid for reads (RLS enforces auth regardless), and the refresh
  // still happens on the real navigation request moments later.
  const isPrefetch =
    request.headers.get("next-router-prefetch") === "1" || request.headers.get("purpose") === "prefetch";
  if (isPrefetch) {
    return NextResponse.next({ request });
  }

  const lockKey = authCookieKey(() => request.cookies.getAll());

  const cookiesToApply = await withRefreshLock(lockKey, async () => {
    const collected: { name: string; value: string; options: CookieOptions }[] = [];
    const supabase = createServerClient<Database>(env.url, env.anonKey, {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(toSet) {
          collected.push(...toSet);
        },
      },
    });

    // IMPORTANT: getUser() (not getSession()) — it revalidates the JWT with
    // the auth server and triggers the refresh that this middleware exists
    // to persist. Do not remove even though the result is unused.
    const { error } = await supabase.auth.getUser();

    // Next.js sends more than one request per real navigation for the same
    // URL (a document request plus a background RSC data request) — found
    // while verifying this fix, both land here, both uncached, even after
    // filtering prefetches above. Whichever redeems the refresh token first
    // wins; GoTrue rejects the loser with `refresh_token_already_used`. Left
    // alone, @supabase/auth-js reacts to that error by clearing the local
    // session — `setAll` above gets called with an EMPTY session — which
    // this middleware would then write back as the response's cookie,
    // signing the user out even though the winning sibling request just
    // established a perfectly valid new session a moment earlier. So: on
    // exactly this error, discard whatever empty/partial cookies got
    // collected and pass the request through with its original cookies
    // untouched. The winning sibling's response already carries the
    // rotated cookie to the browser; this response doesn't need to repeat
    // it, and must not overwrite it with a clear.
    if (error?.code === "refresh_token_already_used") {
      return [];
    }
    return collected;
  });

  const supabaseResponse = NextResponse.next({ request });
  cookiesToApply.forEach(({ name, value, options }) => {
    request.cookies.set(name, value);
    supabaseResponse.cookies.set(name, value, options);
  });

  return supabaseResponse;
}
