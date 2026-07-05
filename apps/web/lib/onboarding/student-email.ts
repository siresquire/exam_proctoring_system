/**
 * Phase 3a: the synthetic-email identity model.
 *
 * There is no verified sending domain, so student accounts cannot rely on
 * real transactional email (PLAN.md "Student onboarding without a domain").
 * Every student account is still, underneath, a normal Supabase Auth user
 * with an `email` column (Supabase Auth requires one) — so onboarding gives
 * each student a NON-ROUTABLE, STABLE synthetic email derived from their
 * USTED index number: `<index>@students.usted.local`.
 *
 * This address is never emailed to anyone and never displayed as a contact
 * method — it exists purely as a stable internal auth identifier so
 * `supabase.auth.signInWithPassword({ email, password })` has something to
 * key on. The `.local` TLD is reserved by RFC 6762 for link-local mDNS and
 * is not resolvable/routable on the public internet, which is exactly the
 * property wanted here: even if this address ever leaked into a real email
 * field somewhere, nothing could actually be delivered to it.
 *
 * The existing index-number login path (`app/login/actions.ts`'s
 * `resolveEmailForIndexNumber`) already resolves a 10-digit index to
 * `profiles.student_number` -> the matching `auth.users` row -> that row's
 * `email`, then signs in with the real password against that email. Because
 * account creation here always sets `profiles.student_number` to the same
 * index used to build the synthetic email, that resolution path works
 * completely unmodified for these accounts — see the RLS smoke test's new
 * section for a created-account round-trip through `signIn()`'s resolver.
 */

export const STUDENT_EMAIL_DOMAIN = "students.usted.local";

const INDEX_NUMBER_PATTERN = /^\d{10}$/;

/** Builds the synthetic, non-routable auth email for a 10-digit USTED index number. */
export function studentEmailForIndex(indexNumber: string): string {
  if (!INDEX_NUMBER_PATTERN.test(indexNumber)) {
    throw new Error(`studentEmailForIndex: "${indexNumber}" is not a 10-digit index number.`);
  }
  return `${indexNumber}@${STUDENT_EMAIL_DOMAIN}`;
}

export function isIndexNumber(value: string): boolean {
  return INDEX_NUMBER_PATTERN.test(value);
}

export { INDEX_NUMBER_PATTERN };
