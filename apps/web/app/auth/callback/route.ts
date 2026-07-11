import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/server";

/**
 * Auth callback for magic links and email confirmations.
 *
 * Handles both link styles Supabase sends:
 * - PKCE flow: `?code=...` -> exchangeCodeForSession
 * - Email OTP flow: `?token_hash=...&type=magiclink|signup|...` -> verifyOtp
 *
 * On success, sends the user to `next` (default /dashboard, which routes
 * them to their role's dashboard). On failure, back to /login with an
 * error code the login page surfaces via notify.error.
 *
 * SECURITY NOTE (self-signup removal): the login page's "Email me a link"
 * tab — the only code path that ever produced a link pointing here — has
 * been removed (components/auth/login-form.tsx), because
 * `supabase.auth.signInWithOtp()` without `shouldCreateUser: false` silently
 * creates a new account for ANY email, i.e. open self-signup. Nothing in
 * this app calls `signInWithOtp` or `signUp` anymore, so this route is
 * currently unreachable in practice. It is intentionally left in place
 * (not deleted) as dead-but-harmless: it does nothing unless Supabase
 * actually sends a request here, which it now never does from this app's
 * own flows, and it's the natural landing point for a future, deliberately
 * re-added flow (e.g. an admin-triggered password-reset email) that would
 * reuse the same `code`/`token_hash` handling. Self-signup itself is
 * disabled at the Supabase project layer too — see README.md "Self-signup
 * is disabled" and supabase/config.toml's `enable_signup = false`.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const rawNext = searchParams.get("next") ?? "/dashboard";
  // Only allow same-origin relative redirects — never a foreign URL.
  const next = rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/dashboard";

  const supabase = await createClient();
  if (!supabase) {
    return NextResponse.redirect(`${origin}/login?error=not_configured`);
  }

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
  } else if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth_callback`);
}
