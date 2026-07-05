-- Phase 1.5 (B3): identity verification before every proctored session.
--
-- Adds identity columns to proctor_sessions, gates session creation behind an
-- explicit attestation, cross-checks the claimed index number against the
-- profile's registry student_number (mismatch = high-severity flag, never a
-- hard block — registry data may lag; the portrait is the primary evidence),
-- and adds a one-shot attach_identity_portrait RPC so the client can upload
-- the portrait to Storage under {session_id}/ and then link it server-side.
--
-- Also: the proctor_events event_type CHECK (created in 000006) and the
-- log_proctor_events validation vocabulary must both learn the two new event
-- types this phase introduces — 'identity_mismatch' and 'session_terminated'.
-- log_proctor_events already lists them (20260705000001); this migration
-- extends the TABLE CHECK to match, so the server-side inserts below (and the
-- ones in 20260705000001) are accepted.

-- 1. Extend the proctor_events event_type CHECK ----------------------------

alter table public.proctor_events
  drop constraint proctor_events_event_type_check;

alter table public.proctor_events
  add constraint proctor_events_event_type_check
  check (
    event_type in (
      'tab_hidden',
      'tab_visible',
      'window_blur',
      'window_focus',
      'fullscreen_exit',
      'fullscreen_enter',
      'copy_attempt',
      'paste_attempt',
      'cut_attempt',
      'contextmenu',
      'connection_lost',
      'connection_restored',
      'snapshot_captured',
      'camera_lost',
      'multi_monitor_detected',
      'page_unload',
      'heartbeat',
      'session_start',
      'session_end',
      'concurrent_session_detected',
      'identity_mismatch',
      'session_terminated'
    )
  );

-- 2. Identity columns on proctor_sessions ----------------------------------

alter table public.proctor_sessions
  add column identity_portrait_path text,
  add column claimed_index_number text,
  add column attested_at timestamptz;

comment on column public.proctor_sessions.identity_portrait_path is
  'Storage path ({session_id}/...) of the pre-session identity portrait. Set once via attach_identity_portrait (one-shot). A human reviews it later (Phase 4/5) — no automated face matching.';
comment on column public.proctor_sessions.claimed_index_number is
  'The 10-digit index number the student entered at the identity step. Cross-checked against profiles.student_number when that is set (mismatch logs an identity_mismatch flag, not a block).';
comment on column public.proctor_sessions.attested_at is
  'When the student affirmed the impersonation attestation. Non-null is required to create the session (start_proctor_session raises otherwise).';

-- 3. profiles.student_number CHECK + seed the student test user ------------
-- USTED index numbers are 10 numeric digits (e.g. 5201040845). The CHECK
-- tolerates NULL automatically (Postgres CHECK passes on NULL), so existing
-- profiles with a null student_number are unaffected.

alter table public.profiles
  add constraint profiles_student_number_format
  check (student_number ~ '^\d{10}$');

comment on constraint profiles_student_number_format on public.profiles is
  'USTED index numbers are exactly 10 digits. NULL is allowed (CHECK passes on NULL) — the constraint only validates set values.';

-- Seed: give ONLY the student test user (student@usted.test) a real index
-- number so identity cross-check + smoke tests have data to work with.
-- superadmin/admin/lecturer keep NULL student_number.
update public.profiles p
set student_number = '5201040845'
from auth.users u
where u.id = p.id and u.email = 'student@usted.test';

-- 4. start_proctor_session gains identity params ---------------------------
-- Overload replaces the 000006/000008 signature. New params:
--   claimed_index_number text  -- the entered index number (nullable)
--   attested boolean           -- MUST be true, else session creation refused
-- Behavior added on top of the existing concurrent-session handling:
--   * refuse (raise) if attested is not true;
--   * stamp attested_at + claimed_index_number on the new session;
--   * if claimed_index_number differs from the profile's student_number
--     WHEN that is set (non-null), log an identity_mismatch (high) event on
--     the new session — a flag, never a block.

create or replace function public.start_proctor_session(
  context text,
  tier smallint default 2,
  claimed_index_number text default null,
  attested boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_context text := context;
  v_tier smallint := tier;
  v_claimed text := claimed_index_number;
  v_attested boolean := attested;
  v_registry_number text;
  new_id uuid;
  old_session record;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if v_context is null or length(trim(v_context)) = 0 then
    raise exception 'context is required';
  end if;

  if v_tier is null or v_tier < 1 or v_tier > 4 then
    raise exception 'tier must be between 1 and 4';
  end if;

  -- Identity attestation gate (Phase 1.5): the client can present whatever
  -- UI it likes, but the session simply cannot be created without an
  -- affirmative attestation recorded server-side.
  if v_attested is not true then
    raise exception 'Identity attestation is required before starting a proctored session';
  end if;

  -- Concurrent-session detection (unchanged from 000008): abandon+flag any
  -- still-active session for this user+context rather than blocking.
  select s.id into old_session
  from public.proctor_sessions s
  where s.user_id = auth.uid() and s.context = v_context and s.status = 'active'
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
    (user_id, context, integrity_tier, consent_given_at, user_agent, status, claimed_index_number, attested_at)
  values (
    auth.uid(),
    v_context,
    v_tier,
    now(),
    current_setting('request.headers', true)::jsonb ->> 'user-agent',
    'active',
    v_claimed,
    now()
  )
  returning id into new_id;

  insert into public.proctor_events (session_id, event_type, severity, occurred_at, meta)
  values (new_id, 'session_start', 'info', now(), jsonb_build_object('tier', v_tier, 'context', v_context));

  -- Cross-check the claimed index number against the registry value WHEN it
  -- is set. Mismatch is a high-severity flag on this session, not a block.
  select student_number into v_registry_number
  from public.profiles
  where id = auth.uid();

  if v_claimed is not null and v_registry_number is not null and v_claimed <> v_registry_number then
    insert into public.proctor_events (session_id, event_type, severity, occurred_at, meta)
    values (
      new_id,
      'identity_mismatch',
      'high',
      now(),
      jsonb_build_object('claimed', v_claimed, 'reason', 'claimed_index_number_differs_from_registry')
    );
  end if;

  return new_id;
end;
$$;

comment on function public.start_proctor_session(text, smallint, text, boolean) is
  'Creates a proctoring session for auth.uid(). Refuses unless attested = true (identity attestation gate). Records consent + attested_at + claimed_index_number, abandons+flags any still-active session for the same user+context, logs session_start, and — when the claimed index number differs from the profile''s registry student_number (both set) — logs a high-severity identity_mismatch flag (a signal, never a block). Returns the new session id.';

grant execute on function public.start_proctor_session(text, smallint, text, boolean) to authenticated;

-- Drop the older 3-arg-less signatures so callers must pass the identity
-- params (the old 2-arg form would silently create attestation-less
-- sessions). Both prior signatures resolve to (text, smallint).
drop function if exists public.start_proctor_session(text, smallint);

-- 5. attach_identity_portrait RPC ------------------------------------------
-- Owner-only, own ACTIVE session only, one-shot (identity_portrait_path must
-- be NULL). The client creates the session, uploads the JPEG to Storage
-- under {session_id}/... (storage RLS in 000007 already gates that to the
-- owner of an active session), then calls this to link the path — done
-- server-side so a hostile client can't point the session at someone else's
-- object or overwrite an attached portrait.

create or replace function public.attach_identity_portrait(session_id uuid, storage_path text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner_id uuid;
  current_status text;
  existing_path text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select user_id, status, identity_portrait_path
    into owner_id, current_status, existing_path
  from public.proctor_sessions
  where id = attach_identity_portrait.session_id
  for update;

  if owner_id is null then
    raise exception 'Session % not found', session_id;
  end if;

  if owner_id <> auth.uid() then
    raise exception 'Only the session owner may attach an identity portrait';
  end if;

  if current_status <> 'active' then
    raise exception 'Session % is not active', session_id;
  end if;

  if existing_path is not null then
    raise exception 'An identity portrait is already attached to session %', session_id;
  end if;

  if storage_path is null or storage_path not like (attach_identity_portrait.session_id::text || '/%') then
    raise exception 'storage_path must be prefixed with the session id';
  end if;

  update public.proctor_sessions
  set identity_portrait_path = storage_path
  where id = attach_identity_portrait.session_id;
end;
$$;

comment on function public.attach_identity_portrait(uuid, text) is
  'Owner-only, one-shot: links a pre-uploaded identity portrait (Storage path {session_id}/...) to the caller''s own ACTIVE session. Fails if the session already has a portrait, is not active, or is not owned by the caller. Lets the client do create-session -> upload -> attach without being able to tamper with the linkage.';

grant execute on function public.attach_identity_portrait(uuid, text) to authenticated;
