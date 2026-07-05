/**
 * Cross-callsite mutex for Supabase session refresh.
 *
 * Why this exists: refresh-token rotation is single-use (GoTrue rejects a
 * refresh token the moment a second request tries to redeem it — "Invalid
 * Refresh Token: Already Used"). In this app, TWO independent places call
 * `supabase.auth.getUser()` (which silently redeems the refresh token when
 * the access token has expired) for the same request/navigation:
 *
 * 1. The SSR middleware (`lib/supabase/middleware.ts`, the @supabase/ssr
 *    "updateSession" pattern) — runs on every request.
 * 2. Server Components / actions (`lib/supabase/server.ts`'s `createClient`,
 *    used by `lib/auth.ts#getSessionProfile`) — reads cookies via
 *    `next/headers`.
 *
 * Both read cookies from the SAME incoming request. The @supabase/ssr docs'
 * usual assumption — that middleware mutating `request.cookies` propagates
 * into the subsequent Server Component render, so only middleware ever
 * actually needs to refresh — did not hold up empirically here (reproduced
 * against Next.js 16 + local Supabase: middleware refreshes and rotates the
 * token, and the very next `getSessionProfile()` call in the same
 * navigation still reads the OLD refresh token and gets
 * `refresh_token_already_used`, wiping the session). Rather than depend on
 * that propagation guarantee, every caller that might trigger a refresh
 * goes through `withRefreshLock` below, keyed by the refresh token
 * currently in the cookie: the first caller does the real GoTrue round
 * trip, every other caller (concurrent OR immediately sequential, as long
 * as it's still holding the pre-rotation key) awaits the same promise and
 * reuses its result instead of spending the token a second time.
 *
 * IMPORTANT LIMITATION, found while verifying this fix: this only dedupes
 * callers that share a JS heap. `lib/supabase/middleware.ts` (`proxy.ts`)
 * runs on Next's Edge runtime; `lib/auth.ts#getSessionProfile` (via Server
 * Components) runs in the Node.js runtime. Those are two separate
 * processes/isolates — the module-level `inFlight` Map below is NOT shared
 * between them, so this lock cannot by itself prevent the middleware call
 * and the Server Component call from both trying to redeem the same token.
 * It still fully protects same-isolate races (e.g. two Server Components in
 * one Node render — the common case `getSessionProfile`'s `cache()`
 * wrapper already collapses, and any future same-isolate caller this lock
 * is added for). The Edge/Node race is instead made survivable by two other
 * measures, both required together:
 *   1. `refresh_token_reuse_interval` in supabase/config.toml — tells GoTrue
 *      to hand back the SAME just-rotated session (not an error) to a
 *      second caller presenting the previous token within the grace window,
 *      instead of hard-failing.
 *   2. `lib/supabase/middleware.ts` skipping the refresh entirely on Next's
 *      RSC prefetch requests — those fire in bulk for every visible <Link>
 *      and, left unfiltered, flood the reuse window with far more
 *      competing redemptions than it's meant to absorb (and can trip
 *      GoTrue's abuse rate-limiter on top of the race).
 */

interface LockedResult<T> {
  promise: Promise<T>;
}

const inFlight = new Map<string, LockedResult<unknown>>();

/**
 * Runs `fn` at most once per `key` while a call for that key is in flight;
 * concurrent/near-simultaneous callers with the same key await the same
 * result. `key` should be derived from the refresh token that is about to
 * be redeemed, so a *different* key (a session that already rotated) always
 * gets its own fresh call.
 */
export async function withRefreshLock<T>(key: string | null, fn: () => Promise<T>): Promise<T> {
  if (!key) return fn();

  const existing = inFlight.get(key);
  if (existing) return existing.promise as Promise<T>;

  const promise = fn().finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, { promise });
  return promise;
}
