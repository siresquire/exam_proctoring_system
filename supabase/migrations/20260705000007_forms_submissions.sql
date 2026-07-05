-- Phase 2b: Apps Script onFormSubmit cross-check — bypass detection for the
-- Google Forms wrapper (System 1).
--
-- The gap this closes: a student who learns the raw Google Form URL
-- (docs.google.com/forms/d/e/<id>/viewform, without the "embedded=true" and
-- without going through our /exam/forms/<id> wrapper) can fill in and submit
-- the form completely unproctored. We cannot see that submission at all from
-- our side — the form runs entirely on Google's servers in a cross-origin
-- iframe (see README.md "The honest cross-origin limitation").
--
-- The mitigation (PLAN.md Phase 2b, RESEARCH.md §1): the lecturer installs a
-- small Apps Script on their own form (apps-script/forms-proctor-crosscheck.gs)
-- that runs an onFormSubmit installable trigger SERVER-SIDE IN GOOGLE'S CLOUD,
-- after every submission (including ones that bypassed our wrapper entirely —
-- that's the whole point). It POSTs { forms_exam_id, respondent_email,
-- submitted_at } to our webhook (apps/web/app/api/forms/submission/route.ts),
-- authenticated by a per-exam shared secret (submission_secret below, never
-- the student's session — there is no student session for a bypass
-- submission). The webhook cross-checks the submission against
-- proctor_sessions for that form and records a match_status.
--
-- Trust model (read this before touching the webhook route):
--   - The ONLY thing the webhook trusts is a constant-time compare of the
--     shared secret against forms_exams.submission_secret. Everything else in
--     the request body (respondent_email, submitted_at, forms_exam_id) is
--     UNVERIFIED CLIENT INPUT from Google's side, same trust level as any
--     other webhook payload — it is cross-checked against our own
--     proctor_sessions data, never taken as ground truth on its own.
--   - The secret is generated server-side (rotate_forms_exam_secret) and
--     shown to the lecturer exactly once per rotation, like an API key.
--   - forms_submissions is append-only for clients: even the exam owner
--     cannot edit or delete a submission row. Only the service-role webhook
--     inserts (service role bypasses RLS entirely, so there is no INSERT
--     policy for authenticated users at all — see the RLS section below).

-- 1. forms_exams: submission_secret + rotation RPC -------------------------

alter table public.forms_exams
  add column submission_secret text;

comment on column public.forms_exams.submission_secret is
  'Phase 2b: per-exam shared secret the Apps Script webhook (apps/web/app/api/forms/submission/route.ts) authenticates with, sent as the x-forms-secret header. Null until the lecturer generates one via rotate_forms_exam_secret(). Never exposed to students — only readable by the owner/lecturer-or-higher SELECT policy already on this table, and even then only the lecturer''s own UI surfaces it (in the "Bypass detection" config panel, shown once like an API key).';

create or replace function public.rotate_forms_exam_secret(forms_exam_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
  v_secret text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select owner_id into v_owner
  from public.forms_exams
  where id = rotate_forms_exam_secret.forms_exam_id;

  if v_owner is null then
    raise exception 'Forms exam % not found', forms_exam_id;
  end if;

  if v_owner <> auth.uid() and not public.has_role('lecturer') then
    raise exception 'Only the exam owner or a lecturer may rotate its submission secret';
  end if;

  -- 24 random bytes -> 48 hex chars. Plenty of entropy for a shared secret
  -- that is never brute-forceable over the network (the route compares in
  -- constant time and this isn't a login form with unlimited guesses tied to
  -- a username — but generous length costs nothing).
  --
  -- gen_random_bytes lives in the pgcrypto extension, installed in the
  -- `extensions` schema on Supabase (not `public`) — must be schema-qualified
  -- here because this function runs with `search_path = ''` (the same
  -- definer-function hardening as every other function in this repo), so an
  -- unqualified call would fail with "function gen_random_bytes does not
  -- exist" despite the extension being installed.
  v_secret := encode(extensions.gen_random_bytes(24), 'hex');

  update public.forms_exams
  set submission_secret = v_secret
  where id = rotate_forms_exam_secret.forms_exam_id;

  return v_secret;
end;
$$;

comment on function public.rotate_forms_exam_secret(uuid) is
  'Generates and stores a new random submission_secret for a forms_exams row, returning it ONCE so the lecturer UI can display it in the Apps Script config panel (like showing an API key at creation time — it is not retrievable again after this call returns, only re-rotatable). Owner-or-lecturer-or-higher only.';

grant execute on function public.rotate_forms_exam_secret(uuid) to authenticated;

-- 2. forms_submissions table ------------------------------------------------
-- One row per onFormSubmit webhook call. Evidence, not a live queue — append
-- only, like proctor_events/proctor_reports.

create table public.forms_submissions (
  id uuid primary key default gen_random_uuid(),
  forms_exam_id uuid not null references public.forms_exams (id) on delete cascade,
  respondent_email text,
  submitted_at timestamptz,
  received_at timestamptz not null default now(),
  matched_session_id uuid references public.proctor_sessions (id),
  match_status text not null check (match_status in ('matched', 'no_session', 'out_of_window', 'no_email')),
  raw jsonb not null default '{}'::jsonb
);

comment on table public.forms_submissions is
  'Phase 2b: one row per Apps Script onFormSubmit webhook call for a forms_exam. Written ONLY by the service-role webhook route (apps/web/app/api/forms/submission/route.ts) after it authenticates the caller via the per-exam submission_secret and runs the proctor_sessions cross-check — see match_status. Append-only for every client role (no INSERT/UPDATE/DELETE policy at all; the service role bypasses RLS to write, which is by design, not an oversight).';
comment on column public.forms_submissions.respondent_email is
  'From the form response, requires the Google Form''s "Collect email addresses" setting to be ON (apps-script/README.md). Null when that setting is off — recorded as match_status=''no_email'' since matching is by email.';
comment on column public.forms_submissions.matched_session_id is
  'The proctor_sessions row this submission was matched to, when match_status=''matched'' or ''out_of_window''. Null for no_session/no_email.';
comment on column public.forms_submissions.match_status is
  'matched: a proctor_session exists for this form, owned by the user whose profile/auth email equals respondent_email, and submitted_at falls in [started_at, coalesce(ended_at, now())]. out_of_window: such a session exists but submitted_at is outside its window. no_session: no proctor_session exists for that form+user at all — the bypass flag (raw Google Form URL, no wrapper session). no_email: the submission carried no respondent_email to match against (Collect email addresses was off).';
comment on column public.forms_submissions.raw is
  'The full webhook payload as received, for audit/debugging — never displayed verbatim to anyone but the exam owner/lecturer.';

create index forms_submissions_forms_exam_id_idx on public.forms_submissions (forms_exam_id);
create index forms_submissions_match_status_idx on public.forms_submissions (match_status);

-- Append-only enforcement for EDITS: revoke UPDATE outright (belt) and a
-- trigger (braces) so even a future policy mistake can't make existing rows
-- mutable by a client role. UPDATE is blocked unconditionally, including for
-- the service role — an evidence row must never change after the fact.
--
-- DELETE is deliberately NOT blocked by a trigger, unlike UPDATE: this table
-- has `forms_exam_id ... references public.forms_exams (id) on delete
-- cascade` above, so deleting a forms_exams row (a normal, RLS-guarded
-- owner/lecturer action — see forms_exams_delete_owner_or_lecturer,
-- 20260705000005) must be able to cascade-delete its submissions. An
-- unconditional BEFORE DELETE trigger would make that cascade fail with
-- "forms_submissions is append-only" and, transitively, break deleting the
-- exam at all. Protection against a CLIENT deleting rows out from under a
-- live exam is still real: REVOKE below removes DELETE from
-- anon/authenticated entirely, and there is no DELETE RLS policy for them
-- either (belt AND a second belt, just not the braces-that-also-catches-
-- cascades). Only the service role (which already bypasses RLS for
-- everything else this feature does) or a cascade from an authorized
-- forms_exams delete can remove a row.
revoke update, delete on public.forms_submissions from public, anon, authenticated;

create or replace function public.forms_submissions_block_update()
returns trigger
language plpgsql
as $$
begin
  raise exception 'forms_submissions is append-only: % is not permitted', tg_op;
end;
$$;

create trigger forms_submissions_no_update
  before update on public.forms_submissions
  for each row
  execute function public.forms_submissions_block_update();

-- 3. RLS on forms_submissions -------------------------------------------------
-- No INSERT policy for authenticated/anon at all: the only writer is the
-- service-role webhook route, which bypasses RLS entirely. SELECT is scoped
-- to the exam owner or lecturer-or-higher, mirroring forms_exams.

alter table public.forms_submissions enable row level security;
alter table public.forms_submissions force row level security;

create policy forms_submissions_select_owner_or_lecturer
  on public.forms_submissions
  for select
  to authenticated
  using (
    public.has_role('lecturer')
    or exists (
      select 1 from public.forms_exams fe
      where fe.id = forms_submissions.forms_exam_id
        and fe.owner_id = auth.uid()
    )
  );

-- 4. forms_exam_submissions RPC — lecturer results view ----------------------
-- Mirrors forms_exam_sessions: a security-definer RPC (not a bare SELECT)
-- because the lecturer results page wants this pre-filtered and the RLS
-- policy above already allows a plain SELECT for the right people anyway —
-- this just gives a stable, ordered shape the UI can rely on without
-- duplicating the owner-or-lecturer check client-side.
create or replace function public.forms_exam_submissions(forms_exam_id uuid)
returns table (
  submission_id uuid,
  respondent_email text,
  submitted_at timestamptz,
  received_at timestamptz,
  match_status text,
  matched_session_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_exam_owner uuid;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select owner_id into v_exam_owner
  from public.forms_exams
  where id = forms_exam_submissions.forms_exam_id;

  if v_exam_owner is null then
    raise exception 'Forms exam % not found', forms_exam_id;
  end if;

  if v_exam_owner <> auth.uid() and not public.has_role('lecturer') then
    raise exception 'Only the exam owner or a lecturer may view its submissions';
  end if;

  return query
  select
    s.id as submission_id,
    s.respondent_email,
    s.submitted_at,
    s.received_at,
    s.match_status,
    s.matched_session_id
  from public.forms_submissions s
  where s.forms_exam_id = forms_exam_submissions.forms_exam_id
  order by s.received_at desc;
end;
$$;

comment on function public.forms_exam_submissions(uuid) is
  'Phase 2b lecturer results view: one row per Apps Script onFormSubmit webhook call recorded for this forms_exam, with its match_status. SELECT-guarded to the exam owner or lecturer-or-higher, same posture as forms_exam_sessions.';

grant execute on function public.forms_exam_submissions(uuid) to authenticated;

-- 5. cross-check helper: match a submission against proctor_sessions --------
-- Called by the webhook route (via the service-role client, which can also
-- call security-definer RPCs) rather than duplicating this join in
-- application code. SECURITY DEFINER because it reads auth.users (email),
-- which no client role can query directly, and proctor_sessions across
-- users. It performs classification ONLY — it does not insert anything,
-- keeping the actual forms_submissions insert in the route handler where the
-- secret check already happened, so this function's blast radius if ever
-- misused is "tells you a match_status", never "writes evidence rows".
--
-- Per the task brief's security lesson (20260705000006): this function
-- trusts its arguments to classify a hypothetical submission and returns
-- data, it does not gate access to anything privileged by itself, but it
-- still must not be callable by students to go fishing for another user's
-- session existence/timing via forms_exam_id + guessed emails. So EXECUTE is
-- revoked from anon/authenticated below, exactly like _create_proctor_session
-- — only the service role (which already bypasses RLS for everything this
-- function reads anyway) may call it.
create or replace function public.match_forms_submission(
  forms_exam_id uuid,
  respondent_email text,
  submitted_at timestamptz
)
returns table (
  match_status text,
  matched_session_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_context text;
  v_user_id uuid;
  v_session record;
begin
  if respondent_email is null or length(trim(respondent_email)) = 0 then
    return query select 'no_email'::text, null::uuid;
    return;
  end if;

  v_context := 'form:' || match_forms_submission.forms_exam_id::text;

  select id into v_user_id
  from auth.users
  where lower(email) = lower(trim(match_forms_submission.respondent_email))
  limit 1;

  if v_user_id is null then
    return query select 'no_session'::text, null::uuid;
    return;
  end if;

  -- Most recent session for this user+form context that could plausibly
  -- contain submitted_at, preferring an in-window match over a merely
  -- recent one: order by whether the window contains submitted_at first,
  -- then by recency.
  select ps.id, ps.started_at, ps.ended_at
  into v_session
  from public.proctor_sessions ps
  where ps.user_id = v_user_id
    and ps.context = v_context
  order by
    (
      match_forms_submission.submitted_at is not null
      and ps.started_at <= match_forms_submission.submitted_at
      and match_forms_submission.submitted_at <= coalesce(ps.ended_at, now())
    ) desc,
    ps.started_at desc
  limit 1;

  if v_session.id is null then
    return query select 'no_session'::text, null::uuid;
    return;
  end if;

  if match_forms_submission.submitted_at is not null
     and v_session.started_at <= match_forms_submission.submitted_at
     and match_forms_submission.submitted_at <= coalesce(v_session.ended_at, now()) then
    return query select 'matched'::text, v_session.id;
  else
    return query select 'out_of_window'::text, v_session.id;
  end if;
end;
$$;

comment on function public.match_forms_submission(uuid, text, timestamptz) is
  'INTERNAL cross-check used by the forms-submission webhook route (service role only — EXECUTE revoked from anon/authenticated below, same lock-down pattern as _create_proctor_session/20260705000006). Given a forms_exam_id + respondent_email + submitted_at, resolves the email to an auth.users id, finds that user''s proctor_sessions row for context=''form:<id>'', and classifies: no_email (blank input), no_session (no such user, or no session for that user against this form), out_of_window (a session exists but submitted_at falls outside [started_at, coalesce(ended_at, now())]), matched (in-window). Does not write anything — pure classification, callers insert forms_submissions themselves.';

revoke execute on function public.match_forms_submission(uuid, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.match_forms_submission(uuid, text, timestamptz) to service_role;
