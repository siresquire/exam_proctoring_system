import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

/**
 * Phase 2b webhook: the Apps Script `onFormSubmit` trigger
 * (apps-script/forms-proctor-crosscheck.gs) POSTs here after every
 * submission to a lecturer's Google Form — including submissions that never
 * went through our proctored wrapper at all, which is the entire point (see
 * the migration comment on supabase/migrations/20260705000007_forms_submissions.sql
 * for the full trust-model writeup).
 *
 * TRUST MODEL — read this before changing anything here:
 *   - This route is PUBLIC (unauthenticated by session — Apps Script has no
 *     Supabase session to send). proxy.ts's matcher excludes nothing for
 *     API routes, but updateSession() only refreshes cookies; it does not
 *     gate access, so an unauthenticated POST reaches this handler fine.
 *   - The ONLY thing this route trusts is a constant-time comparison of the
 *     `x-forms-secret` header against forms_exams.submission_secret for the
 *     forms_exam_id in the body. Everything else in the body
 *     (respondent_email, submitted_at, raw) is unverified input from
 *     Google's side and is treated exactly like that: recorded, then
 *     cross-checked against our OWN proctor_sessions data (never taken as
 *     ground truth about who submitted what).
 *   - On a secret mismatch we return 401. On an unknown forms_exam_id we
 *     return 404 — this does leak "exam exists or not", but forms_exam_id is
 *     already a value the lecturer hands to Apps Script (a UUID, not a
 *     guessable secret), so this is an acceptable, documented trade-off
 *     (matching how the rest of this codebase treats non-secret ids).
 *     compared value (the secret) uses a fixed-time compare regardless.
 *   - Writes go through the SERVICE-ROLE client because there is no
 *     authenticated user on this request at all — RLS has nothing to key
 *     off. That is exactly why the secret check above is the only gate:
 *     once past it, this code has the same write power as any other
 *     service-role code path in this repo, so validate/limit the input
 *     tightly (size caps, field shape) rather than assuming "it's server
 *     code, it's fine".
 */

export const runtime = "nodejs";

const MAX_BODY_BYTES = 8 * 1024; // generous for {uuid, email, iso date, small raw blob}
const MAX_EMAIL_LENGTH = 320; // RFC 5321 upper bound
const MAX_RAW_JSON_BYTES = 4 * 1024;

interface SubmissionBody {
  forms_exam_id?: unknown;
  respondent_email?: unknown;
  submitted_at?: unknown;
  raw?: unknown;
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

/** Constant-time string compare — never short-circuit on the secret. */
function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  // timingSafeEqual throws on length mismatch; compare against a
  // same-length-but-wrong buffer first so length itself leaks no timing
  // signal beyond "did the request bother sending a same-length guess".
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export async function POST(request: NextRequest) {
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  let body: SubmissionBody;
  try {
    body = JSON.parse(rawBody) as SubmissionBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const formsExamId = body.forms_exam_id;
  if (!isUuid(formsExamId)) {
    return NextResponse.json({ error: "forms_exam_id must be a UUID" }, { status: 400 });
  }

  const suppliedSecret = request.headers.get("x-forms-secret");
  if (!suppliedSecret || suppliedSecret.length === 0) {
    return NextResponse.json({ error: "Missing x-forms-secret header" }, { status: 401 });
  }

  const admin = createAdminClient();
  if (!admin) {
    return NextResponse.json({ error: "Supabase is not configured" }, { status: 500 });
  }

  const { data: exam, error: examError } = await admin
    .from("forms_exams")
    .select("id, submission_secret")
    .eq("id", formsExamId)
    .maybeSingle();

  if (examError) {
    return NextResponse.json({ error: "Lookup failed" }, { status: 500 });
  }

  if (!exam) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (!exam.submission_secret || !safeCompare(exam.submission_secret, suppliedSecret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Past the secret gate. Validate/limit the remaining fields — this is
  // still untrusted input, just now attributable to whoever holds this
  // exam's secret (the lecturer's own Apps Script, in the intended flow).
  let respondentEmail: string | null = null;
  if (typeof body.respondent_email === "string" && body.respondent_email.trim().length > 0) {
    respondentEmail = body.respondent_email.trim().slice(0, MAX_EMAIL_LENGTH);
  }

  let submittedAt: string | null = null;
  if (typeof body.submitted_at === "string") {
    const parsed = new Date(body.submitted_at);
    if (!Number.isNaN(parsed.getTime())) {
      submittedAt = parsed.toISOString();
    }
  }

  let raw: unknown = {};
  if (body.raw !== undefined) {
    const rawString = JSON.stringify(body.raw ?? {});
    if (rawString.length <= MAX_RAW_JSON_BYTES) {
      raw = body.raw;
    } else {
      raw = { truncated: true };
    }
  }

  // Cross-check against proctor_sessions via the service-role-only RPC (see
  // migration comment on match_forms_submission — EXECUTE is revoked from
  // anon/authenticated, exactly like _create_proctor_session, because it
  // reads auth.users and other users' session data).
  const { data: matchRows, error: matchError } = await admin.rpc("match_forms_submission", {
    forms_exam_id: formsExamId,
    respondent_email: respondentEmail,
    submitted_at: submittedAt,
  });

  if (matchError) {
    return NextResponse.json({ error: "Cross-check failed" }, { status: 500 });
  }

  const match = matchRows?.[0] ?? { match_status: "no_email", matched_session_id: null };

  const { error: insertError } = await admin.from("forms_submissions").insert({
    forms_exam_id: formsExamId,
    respondent_email: respondentEmail,
    submitted_at: submittedAt,
    matched_session_id: match.matched_session_id,
    match_status: match.match_status,
    raw: raw as Json,
  });

  if (insertError) {
    return NextResponse.json({ error: "Could not record submission" }, { status: 500 });
  }

  // Minimal ack — Apps Script doesn't need (and shouldn't get) match_status
  // back; the lecturer reviews it in the results UI, not in Apps Script logs
  // that a curious student could theoretically view if they had editor
  // access. 200 with a tiny, stable body.
  return NextResponse.json({ ok: true }, { status: 200 });
}
