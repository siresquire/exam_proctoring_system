"use server";

import { redirect } from "next/navigation";

import { DASHBOARD_BY_ROLE } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

const INDEX_NUMBER_PATTERN = /^\d{10}$/;

/** Generic failure message for every sign-in failure — see signIn's doc comment for why this must never vary. */
const GENERIC_SIGN_IN_ERROR = "Invalid email/index number or password.";

export interface SignInResult {
  error: string;
}

/**
 * Password sign-in, accepting either an email or a 10-digit USTED index
 * number as the identifier (PLAN.md "Student onboarding without a domain").
 *
 * Index -> email resolution runs here, server-side, via the service-role
 * client (`lib/supabase/admin.ts`) — it has to: `profiles.student_number`
 * is RLS-protected and the caller isn't authenticated yet at this point, so
 * no anon-key client could read it, by design. The resolved email is used
 * immediately for the real password check and is never returned to the
 * caller.
 *
 * Every failure path — unknown index, unknown email, wrong password, index
 * that resolves to an account with no email on file — returns the exact
 * same generic message. This is deliberate: distinguishing "no such index
 * number" from "wrong password" would let an attacker enumerate valid
 * USTED index numbers by trying candidates against this form and watching
 * which error comes back. Real failures are still observable server-side
 * (Supabase auth logs / audit_log) for support purposes; nothing about
 * *why* a specific attempt failed is exposed to the client.
 *
 * The actual password verification goes through `lib/supabase/server.ts`'s
 * cookie-bound SSR client so a successful sign-in writes the session
 * cookies Next.js needs — `supabase-js`'s plain client (or the service-role
 * client above) can't do that; only the `@supabase/ssr` server client
 * wired to `next/headers` can.
 */
export async function signIn(identifier: string, password: string): Promise<SignInResult> {
  const trimmed = identifier.trim();
  if (!trimmed || !password) {
    return { error: GENERIC_SIGN_IN_ERROR };
  }

  let email: string;
  if (INDEX_NUMBER_PATTERN.test(trimmed)) {
    const resolved = await resolveEmailForIndexNumber(trimmed);
    if (!resolved) {
      return { error: GENERIC_SIGN_IN_ERROR };
    }
    email = resolved;
  } else {
    email = trimmed;
  }

  const supabase = await createClient();
  if (!supabase) {
    return { error: GENERIC_SIGN_IN_ERROR };
  }

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.user) {
    return { error: GENERIC_SIGN_IN_ERROR };
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, status")
    .eq("id", data.user.id)
    .single();

  // Phase 4: the password matched, so the identity is already proven —
  // unlike the generic sign-in error above, telling a suspended/removed
  // user WHY they're blocked here isn't an enumeration risk. Sign them back
  // out immediately (the password check above already wrote a session
  // cookie) so a blocked account never completes login, even for the one
  // request that follows this redirect.
  if (profile && profile.status !== "active") {
    await supabase.auth.signOut();
    return {
      error:
        profile.status === "removed"
          ? "This account has been removed. Please contact your administrator."
          : "Your account has been suspended. Please contact your administrator.",
    };
  }

  redirect(profile ? DASHBOARD_BY_ROLE[profile.role] : "/dashboard");
}

/**
 * Resolves a 10-digit USTED index number to the email on the matching
 * auth.users row, via the service-role client. Returns null on ANY failure
 * (no matching profile, profile with no student_number, user record
 * missing, no email on the user) — callers must not distinguish these from
 * each other or from "wrong password" (see signIn's doc comment).
 */
async function resolveEmailForIndexNumber(indexNumber: string): Promise<string | null> {
  const admin = createAdminClient();
  if (!admin) return null;

  const { data: profile } = await admin
    .from("profiles")
    .select("id")
    .eq("student_number", indexNumber)
    .maybeSingle();
  if (!profile) return null;

  const { data, error } = await admin.auth.admin.getUserById(profile.id);
  if (error || !data.user?.email) return null;

  return data.user.email;
}
