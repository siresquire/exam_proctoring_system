-- Phase 2a: System 1, the proctored Google Forms wrapper.
--
-- Lecturers attach proctoring to an ordinary Google Form quiz; students take
-- it inside our monitored wrapper page. This table stores the lecturer's
-- setup (form URL, integrity tier, violation policy, scheduling window) and
-- a results RPC lets the lecturer see every student's proctoring outcome.
--
-- Central architecture decision (PLAN.md Phase 2, task brief): the exam's
-- tier + violation policy are chosen by the LECTURER and stored on
-- forms_exams. The student must not be able to override them. So session
-- creation for a forms-exam goes through a NEW RPC
-- (start_forms_exam_session) that loads the exam's stored tier/policy
-- SERVER-SIDE and never accepts them from the client — unlike
-- start_proctor_session (demo path), which still lets the caller pass its
-- own violation_policy/tier because there is no owning entity there.
--
-- To avoid drift between the two session-creation paths, this migration
-- extracts the actual session-row-creation logic (concurrent-session
-- detection, insert, session_start event, identity cross-check) out of
-- start_proctor_session into a new internal helper,
-- public._create_proctor_session(...), and rewrites start_proctor_session to
-- delegate to it. start_proctor_session's EXTERNAL signature and behavior
-- are unchanged — see the smoke test's full existing (i)/(j)/(k)/(l)/(m)
-- sections, which must all still pass unmodified against this migration.

-- 1. Shared internal helper: public._create_proctor_session -----------------
-- Leading underscore signals "internal, not a public API" (Postgres has no
-- real function-level access control finer than GRANT/REVOKE EXECUTE, so
-- this is a naming convention, reinforced by NOT granting execute to
-- `authenticated` below — only start_proctor_session and
-- start_forms_exam_session, both security definer, can call it, since a
-- definer function's own EXECUTE privilege is what's checked, not the
-- calling role's).
--
-- Takes an ALREADY-VALIDATED, ALREADY-MERGED violation_policy and tier (the
-- caller is responsible for producing v_policy via the same
-- default_violation_policy()-merge-and-validate procedure
-- start_proctor_session used to do inline) plus the identity/attestation
-- inputs, and performs exactly the row-level work: concurrent-session
-- abandon+flag, insert the new session, log session_start, and the identity
-- cross-check flag. Returns the new session id.
create or replace function public._create_proctor_session(
  context text,
  tier smallint,
  policy jsonb,
  claimed_index_number text,
  attested boolean
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_id uuid;
  old_session record;
  v_registry_number text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if context is null or length(trim(context)) = 0 then
    raise exception 'context is required';
  end if;

  if tier is null or tier < 1 or tier > 4 then
    raise exception 'tier must be between 1 and 4';
  end if;

  if attested is not true then
    raise exception 'Identity attestation is required before starting a proctored session';
  end if;

  -- Concurrent-session detection (unchanged behavior from every prior
  -- start_proctor_session version): abandon+flag any still-active session
  -- for this user+context rather than blocking.
  select s.id into old_session
  from public.proctor_sessions s
  where s.user_id = auth.uid() and s.context = _create_proctor_session.context and s.status = 'active'
  for update;

  if old_session.id is not null then
    update public.proctor_sessions
    set status = 'abandoned', ended_at = now()
    where id = old_session.id;

    insert into public.proctor_events (session_id, event_type, severity, occurred_at, meta)
    values (
      old_session.id,
      'concurrent_session_detected',
      'high',
      now(),
      jsonb_build_object('reason', 'new_session_started_same_context')
    );
  end if;

  insert into public.proctor_sessions
    (user_id, context, integrity_tier, consent_given_at, user_agent, status,
     claimed_index_number, attested_at, violation_policy)
  values (
    auth.uid(),
    _create_proctor_session.context,
    _create_proctor_session.tier,
    now(),
    current_setting('request.headers', true)::jsonb ->> 'user-agent',
    'active',
    _create_proctor_session.claimed_index_number,
    now(),
    _create_proctor_session.policy
  )
  returning id into new_id;

  insert into public.proctor_events (session_id, event_type, severity, occurred_at, meta)
  values (
    new_id,
    'session_start',
    'info',
    now(),
    jsonb_build_object('tier', _create_proctor_session.tier, 'context', _create_proctor_session.context)
  );

  -- Cross-check the claimed index number against the registry value WHEN it
  -- is set. Mismatch is a high-severity flag on this session, not a block.
  select student_number into v_registry_number
  from public.profiles
  where id = auth.uid();

  if _create_proctor_session.claimed_index_number is not null
     and v_registry_number is not null
     and _create_proctor_session.claimed_index_number <> v_registry_number then
    insert into public.proctor_events (session_id, event_type, severity, occurred_at, meta)
    values (
      new_id,
      'identity_mismatch',
      'high',
      now(),
      jsonb_build_object(
        'claimed', _create_proctor_session.claimed_index_number,
        'reason', 'claimed_index_number_differs_from_registry'
      )
    );
  end if;

  return new_id;
end;
$$;

comment on function public._create_proctor_session(text, smallint, jsonb, text, boolean) is
  'Internal helper (leading underscore, not GRANTed to authenticated): the shared session-row-creation logic used by BOTH start_proctor_session (demo/self-service path, caller-supplied policy) and start_forms_exam_session (Phase 2a, exam-owned policy). Callers must pass an already-validated, already-merged violation_policy and tier — this function does no policy merging/validation itself, only the row work: concurrent-session abandon+flag, insert, session_start event, identity cross-check. Returns the new session id.';

-- No GRANT to authenticated: only security-definer callers (which run as
-- the function owner, retaining whatever EXECUTE the owner has) may invoke
-- this. A direct client RPC call would be rejected the same way an
-- unlisted/un-granted function always is.

-- 2. Rewrite start_proctor_session to delegate to the shared helper --------
-- Same external signature as 20260705000004's version
-- (text, smallint, text, boolean, jsonb) and IDENTICAL behavior: merges an
-- optional partial violation_policy override over default_violation_policy()
-- with the same per-key validation, then hands the merged policy + inputs to
-- _create_proctor_session. CREATE OR REPLACE is sufficient (same signature,
-- same return type).
create or replace function public.start_proctor_session(
  context text,
  tier smallint default 2,
  claimed_index_number text default null,
  attested boolean default false,
  violation_policy jsonb default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_overrides jsonb := violation_policy;
  v_policy jsonb;
  v_key text;
  v_entry jsonb;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  -- Build + validate the merged violation policy. Start from the server's
  -- defaults, then apply caller overrides ONE KEY AT A TIME so we can
  -- reject garbage per-key rather than trusting jsonb `||` merge to let
  -- anything through. (Unchanged from 20260705000004.)
  v_policy := public.default_violation_policy();

  if v_overrides is not null then
    if jsonb_typeof(v_overrides) <> 'object' then
      raise exception 'violation_policy must be a JSON object mapping event_type to {severity, counts}';
    end if;

    for v_key, v_entry in select * from jsonb_each(v_overrides)
    loop
      if not (v_policy ? v_key) then
        raise exception 'Unknown event_type in violation_policy: %', v_key;
      end if;

      if jsonb_typeof(v_entry) <> 'object' then
        raise exception 'violation_policy[%] must be an object with severity/counts', v_key;
      end if;

      if v_entry ? 'severity' and not (v_entry ->> 'severity' in ('info', 'low', 'medium', 'high')) then
        raise exception 'violation_policy[%].severity must be one of info/low/medium/high, got %',
          v_key, v_entry ->> 'severity';
      end if;

      if v_entry ? 'counts' and jsonb_typeof(v_entry -> 'counts') <> 'boolean' then
        raise exception 'violation_policy[%].counts must be a boolean, got %', v_key, v_entry -> 'counts';
      end if;

      v_policy := jsonb_set(
        v_policy,
        array[v_key],
        (v_policy -> v_key) || v_entry
      );
    end loop;
  end if;

  return public._create_proctor_session(
    context,
    coalesce(tier, 2)::smallint,
    v_policy,
    claimed_index_number,
    coalesce(attested, false)
  );
end;
$$;

comment on function public.start_proctor_session(text, smallint, text, boolean, jsonb) is
  'Creates a proctoring session for auth.uid(). Refuses unless attested = true. Merges an optional caller-supplied violation_policy (partial overrides, strictly validated: known event types only, valid severity values, boolean counts) over default_violation_policy(), then delegates the actual row creation (concurrent-session abandon+flag, insert, session_start, identity cross-check) to public._create_proctor_session — the same helper start_forms_exam_session uses with the EXAM''s stored policy instead of a caller-supplied one. Today (demo/self-service path) the session owner passes violation_policy directly; Phase 2a introduces the exam-owned alternative. Returns the new session id.';

grant execute on function public.start_proctor_session(text, smallint, text, boolean, jsonb) to authenticated;

-- 3. forms_exams table --------------------------------------------------
-- One row per lecturer-created proctored Google Forms quiz.

create table public.forms_exams (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  title text not null,
  -- Expected to already be normalized to the embeddable form
  -- (".../viewform?embedded=true") by the server action before insert — see
  -- apps/web/lib/forms/google-form-url.ts. Stored as the normalized,
  -- embeddable URL so every reader (student wrapper iframe, lecturer list)
  -- can use it directly with no re-derivation. Must be a public Google Form
  -- ("Anyone with the link can respond") for the iframe to load at all —
  -- org-restricted forms send X-Frame-Options via Google's login redirect
  -- and refuse to embed (docs/RESEARCH.md §1); the student wrapper handles
  -- that failure gracefully but cannot make a restricted form embeddable.
  google_form_url text not null,
  -- PLAN.md §2 integrity tiers (T1 quiz .. T4 high-stakes). Default T2
  -- (monitored: webcam + events, no fullscreen lock) — reasonable default
  -- for a Forms quiz that isn't a locked-down final exam.
  integrity_tier smallint not null default 2 check (integrity_tier between 1 and 4),
  -- Snapshot of the lecturer's chosen policy at CREATE/UPDATE time (kept in
  -- sync by the app on every save while status='draft'; frozen once
  -- published in spirit, though nothing stops a lecturer editing before
  -- close — see forms_exams RLS below). start_forms_exam_session copies
  -- THIS value onto each new proctor_sessions.violation_policy snapshot,
  -- exactly like start_proctor_session does with its caller-supplied
  -- override, so log_proctor_events' server-assigned-severity anti-tamper
  -- guarantee (20260705000004) applies identically here.
  violation_policy jsonb not null default public.default_violation_policy(),
  opens_at timestamptz,
  closes_at timestamptz,
  duration_minutes int check (duration_minutes is null or duration_minutes > 0),
  status text not null default 'draft' check (status in ('draft', 'published', 'closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.forms_exams is
  'Phase 2a (System 1): a lecturer-configured proctored Google Forms quiz. The Google Form itself lives on Google and is embedded read-only in the student wrapper (apps/web/app/exam/forms/[id]) — this table holds only the wrapper''s configuration (tier, violation policy, scheduling window), never the form''s questions/answers, which we structurally cannot see (cross-origin iframe).';
comment on column public.forms_exams.google_form_url is
  'Normalized to the embeddable form (".../viewform?embedded=true") server-side before insert (never trust the client''s normalization) — see the create/update server actions. Must be a public ("Anyone with the link") Google Form for the iframe to load.';
comment on column public.forms_exams.violation_policy is
  'Lecturer-chosen policy (same shape as proctor_sessions.violation_policy / default_violation_policy()), snapshotted onto every session start_forms_exam_session creates for this exam. The STUDENT never supplies this — see start_forms_exam_session, which reads it from this row and ignores any client-supplied policy entirely.';
comment on column public.forms_exams.status is
  'draft: lecturer still editing, never visible to students. published: students may start sessions within [opens_at, closes_at] (both optional — null means no bound on that side). closed: lecturer-ended, no new sessions.';

create index forms_exams_owner_id_idx on public.forms_exams (owner_id);
create index forms_exams_status_idx on public.forms_exams (status);

create or replace function public.forms_exams_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger forms_exams_set_updated_at
  before update on public.forms_exams
  for each row
  execute function public.forms_exams_set_updated_at();

-- 4. RLS on forms_exams ---------------------------------------------------
-- Policy matrix:
--   SELECT  owner OR lecturer_or_higher        -- any lecturer, same known
--                                                  simplification as
--                                                  proctor_* (Phase 3/4
--                                                  scopes to ownership/class
--                                                  — tracked there, not
--                                                  forgotten)
--   SELECT  authenticated (incl. students)      -- ONLY rows that are
--                                                  status='published' AND
--                                                  currently within
--                                                  [opens_at, closes_at]
--                                                  (both bounds optional).
--                                                  Drafts and closed exams
--                                                  are never exposed to a
--                                                  student via a bare
--                                                  SELECT — the wrapper page
--                                                  and dashboard list rely
--                                                  on exactly this policy.
--   INSERT/UPDATE/DELETE  owner OR lecturer_or_higher
--
-- forms_exams.violation_policy IS visible to the student under the
-- published-and-open policy above (there's no narrower column-level SELECT
-- in Postgres RLS) — that's fine: the policy for a session already in
-- progress is exactly what the live monitoring panel needs to display (e.g.
-- "strikes: N of limit"), and it was never meant to be a secret school
-- gotcha. What actually matters is enforced at the RPC layer below: the
-- STUDENT cannot pass their own policy into start_forms_exam_session — only
-- read the one already on the row.

alter table public.forms_exams enable row level security;
alter table public.forms_exams force row level security;

create policy forms_exams_select_owner_or_lecturer
  on public.forms_exams
  for select
  to authenticated
  using (owner_id = auth.uid() or public.has_role('lecturer'));

create policy forms_exams_select_published_and_open
  on public.forms_exams
  for select
  to authenticated
  using (
    status = 'published'
    and (opens_at is null or opens_at <= now())
    and (closes_at is null or closes_at >= now())
  );

create policy forms_exams_insert_owner_or_lecturer
  on public.forms_exams
  for insert
  to authenticated
  with check (owner_id = auth.uid() and public.has_role('lecturer'));

create policy forms_exams_update_owner_or_lecturer
  on public.forms_exams
  for update
  to authenticated
  using (owner_id = auth.uid() or public.has_role('lecturer'))
  with check (owner_id = auth.uid() or public.has_role('lecturer'));

create policy forms_exams_delete_owner_or_lecturer
  on public.forms_exams
  for delete
  to authenticated
  using (owner_id = auth.uid() or public.has_role('lecturer'));

-- 5. start_forms_exam_session RPC ------------------------------------------
-- The student-facing entry point for Phase 2a. Loads the exam's tier +
-- violation_policy SERVER-SIDE and passes them into the shared
-- _create_proctor_session helper — the caller supplies only
-- claimed_index_number + attested, exactly like start_proctor_session's
-- identity inputs, but has NO way to influence tier or policy: there is no
-- tier/policy parameter on this function's signature at all.
create or replace function public.start_forms_exam_session(
  forms_exam_id uuid,
  claimed_index_number text default null,
  attested boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_exam record;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select id, status, integrity_tier, violation_policy, opens_at, closes_at
  into v_exam
  from public.forms_exams
  where id = start_forms_exam_session.forms_exam_id;

  if v_exam.id is null then
    raise exception 'Forms exam % not found', forms_exam_id;
  end if;

  if v_exam.status <> 'published' then
    raise exception 'This exam is not open for attempts (status=%)', v_exam.status;
  end if;

  if v_exam.opens_at is not null and now() < v_exam.opens_at then
    raise exception 'This exam has not opened yet';
  end if;

  if v_exam.closes_at is not null and now() > v_exam.closes_at then
    raise exception 'This exam has closed';
  end if;

  return public._create_proctor_session(
    'form:' || v_exam.id::text,
    v_exam.integrity_tier,
    v_exam.violation_policy,
    claimed_index_number,
    coalesce(attested, false)
  );
end;
$$;

comment on function public.start_forms_exam_session(uuid, text, boolean) is
  'Phase 2a student entry point for a proctored Google Forms exam. Loads integrity_tier + violation_policy from the forms_exams row SERVER-SIDE (never from the caller — there is no tier/policy parameter on this function at all, structurally preventing a client override) and delegates to the same public._create_proctor_session helper start_proctor_session uses, with context = ''form:<forms_exam_id>''. Raises if the exam does not exist, is not status=''published'', or now() is outside [opens_at, closes_at]. Refuses (via _create_proctor_session) unless attested = true. Returns the new proctor_sessions id.';

grant execute on function public.start_forms_exam_session(uuid, text, boolean) to authenticated;

-- 6. forms_exam_sessions RPC — lecturer results view -----------------------
-- Per-session results for one forms_exam: the student's identity + session
-- status/violation standing + whether a proctor_report exists. A
-- security-definer RPC (rather than a view) because it joins
-- proctor_sessions -> profiles -> proctor_reports and must independently
-- re-check that the caller may see this exam's results (owner or
-- lecturer-or-higher) — a plain view would need those same joins gated by
-- RLS on three different tables, which is harder to reason about here than
-- one explicit check.
create or replace function public.forms_exam_sessions(forms_exam_id uuid)
returns table (
  session_id uuid,
  user_id uuid,
  full_name text,
  claimed_index_number text,
  status text,
  violation_count smallint,
  violation_limit smallint,
  started_at timestamptz,
  ended_at timestamptz,
  has_report boolean
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
  where id = forms_exam_sessions.forms_exam_id;

  if v_exam_owner is null then
    raise exception 'Forms exam % not found', forms_exam_id;
  end if;

  if v_exam_owner <> auth.uid() and not public.has_role('lecturer') then
    raise exception 'Only the exam owner or a lecturer may view its results';
  end if;

  return query
  select
    s.id as session_id,
    s.user_id,
    p.full_name,
    s.claimed_index_number,
    s.status,
    s.violation_count,
    s.violation_limit,
    s.started_at,
    s.ended_at,
    exists (select 1 from public.proctor_reports r where r.session_id = s.id) as has_report
  from public.proctor_sessions s
  join public.profiles p on p.id = s.user_id
  where s.context = 'form:' || forms_exam_sessions.forms_exam_id::text
  order by s.started_at desc;
end;
$$;

comment on function public.forms_exam_sessions(uuid) is
  'Phase 2a lecturer results view: one row per proctoring session started against this forms_exam (context = ''form:<id>''), with the student''s full_name/claimed_index_number, session status/violation standing, and whether a proctor_reports row exists. SELECT-guarded to the exam owner or lecturer-or-higher (has_role(''lecturer'') — super_admin passes universally); raises if the exam does not exist or the caller may not view it.';

grant execute on function public.forms_exam_sessions(uuid) to authenticated;
