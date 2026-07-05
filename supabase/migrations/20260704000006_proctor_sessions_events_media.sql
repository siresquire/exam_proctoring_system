-- Phase 1: proctoring engine schema.
-- Three tables (sessions, events, media) shared by System 1 (Forms wrapper,
-- Phase 2) and System 2 (platform exam room, Phase 4) — `context` is the
-- only thing that varies per caller ('demo' now, 'exam:<id>' / 'form:<id>'
-- later). Append-only for clients: every write clients make goes through a
-- security-definer RPC (below), never a direct INSERT/UPDATE/DELETE — same
-- posture as audit_log.
--
-- Client-reported evidence note: `occurred_at` (client clock) vs
-- `received_at` (server clock, stamped by the RPC) is deliberate — the
-- server can never vouch for *when* something really happened on a hostile
-- client, only for when it was told. Comparing the two after the fact is
-- itself a clock-tampering signal (see log_proctor_events below).

create table public.proctor_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- 'demo' (Phase 1), later 'exam:<exam_id>' / 'form:<forms_exam_id>'.
  context text not null,
  status text not null default 'active' check (status in ('active', 'ended', 'abandoned')),
  -- Integrity tier per PLAN.md §2 (T1 quiz .. T4 high-stakes). Demo page
  -- always runs at T2 (webcam + events, no fullscreen lock) by default.
  integrity_tier smallint not null default 2 check (integrity_tier between 1 and 4),
  consent_given_at timestamptz not null,
  user_agent text,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  last_heartbeat_at timestamptz
);

comment on table public.proctor_sessions is
  'One row per proctoring session (demo or real exam attempt). INSERT/UPDATE only via start_proctor_session/end_proctor_session — never directly by clients.';
comment on column public.proctor_sessions.context is
  'Free-form session scope: ''demo'', ''exam:<exam_id>'', ''form:<forms_exam_id>''. Combined with user_id for the one-active-session rule.';
comment on column public.proctor_sessions.integrity_tier is
  'PLAN.md §2 tiers 1-4 (quiz .. high-stakes). Drives which signals the client engine enables.';

-- Concurrent-session detection is a core anti-cheat signal (PLAN.md §3,
-- RESEARCH.md §3 "server-side signals"): a student opening a second session
-- for the same context while one is still active is suspicious. We don't
-- prevent it (a hostile client can always open a new tab) — we detect it,
-- by making "active" unique per (user_id, context) and having
-- start_proctor_session abandon+flag the old one instead of erroring.
create unique index proctor_sessions_one_active_per_user_context
  on public.proctor_sessions (user_id, context)
  where status = 'active';

create index proctor_sessions_user_id_idx on public.proctor_sessions (user_id);
create index proctor_sessions_context_idx on public.proctor_sessions (context);

create table public.proctor_events (
  id bigint generated always as identity primary key,
  session_id uuid not null references public.proctor_sessions (id) on delete cascade,
  event_type text not null check (
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
      'concurrent_session_detected'
    )
  ),
  severity text not null check (severity in ('info', 'low', 'medium', 'high')),
  -- Client-reported timestamp of when the signal actually fired. Never
  -- trust this alone for anything punitive — compare against received_at.
  occurred_at timestamptz not null,
  -- Server truth: when the batch containing this event was accepted.
  -- occurred_at vs received_at drift (beyond normal batching latency) is
  -- itself evidence of client clock tampering or event replay.
  received_at timestamptz not null default now(),
  meta jsonb not null default '{}'::jsonb
);

comment on table public.proctor_events is
  'Append-only. INSERT only via log_proctor_events(), batched from the client. occurred_at is client-reported evidence; received_at is server truth — compare the two for clock-tampering signals.';
comment on column public.proctor_events.occurred_at is
  'Client-reported event time. Evidence, not proof — a hostile client can lie about this.';
comment on column public.proctor_events.received_at is
  'Server-stamped acceptance time (log_proctor_events sets this, ignoring any client-supplied value).';

create index proctor_events_session_id_idx on public.proctor_events (session_id);
create index proctor_events_occurred_at_idx on public.proctor_events (occurred_at);

revoke insert, update, delete on public.proctor_events from anon, authenticated;

create or replace function public.proctor_events_immutable()
returns trigger
language plpgsql
as $$
begin
  raise exception 'proctor_events is append-only: % is not permitted', tg_op;
end;
$$;

create trigger proctor_events_no_update
  before update on public.proctor_events
  for each row
  execute function public.proctor_events_immutable();

create trigger proctor_events_no_delete
  before delete on public.proctor_events
  for each row
  execute function public.proctor_events_immutable();

create table public.proctor_media (
  id bigint generated always as identity primary key,
  session_id uuid not null references public.proctor_sessions (id) on delete cascade,
  -- Path within the 'proctoring' storage bucket, always prefixed
  -- '{session_id}/...' (enforced by storage RLS policy, not here).
  storage_path text not null,
  kind text not null check (kind in ('snapshot', 'clip')),
  captured_at timestamptz not null,
  created_at timestamptz not null default now()
);

comment on table public.proctor_media is
  'Append-only metadata row per uploaded snapshot/clip. The binary itself lives in Supabase Storage bucket ''proctoring'' at storage_path — see storage RLS policies below. INSERT only via log_proctor_events()/record_proctor_media(), never directly.';

create index proctor_media_session_id_idx on public.proctor_media (session_id);

revoke insert, update, delete on public.proctor_media from anon, authenticated;

create or replace function public.proctor_media_immutable()
returns trigger
language plpgsql
as $$
begin
  raise exception 'proctor_media is append-only: % is not permitted', tg_op;
end;
$$;

create trigger proctor_media_no_update
  before update on public.proctor_media
  for each row
  execute function public.proctor_media_immutable();

create trigger proctor_media_no_delete
  before delete on public.proctor_media
  for each row
  execute function public.proctor_media_immutable();

-- RPCs ------------------------------------------------------------------
-- All security definer, `set search_path = ''`, fully-qualified identifiers
-- (same hardening posture as set_user_role/log_audit in
-- 20260704000004_helper_functions.sql / 20260704000005_rls_policies.sql).

create or replace function public.start_proctor_session(context text, tier smallint default 2)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_id uuid;
  old_session record;
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

  -- Concurrent-session detection: if a session is still active for this
  -- user+context, abandon it and log a flag on it rather than blocking the
  -- new session (a hostile client could always just not call
  -- end_proctor_session, so blocking would only punish honest reconnects —
  -- e.g. a crashed tab). The flag is what makes this a *detected* signal
  -- instead of a silent no-op.
  select id into old_session
  from public.proctor_sessions
  where user_id = auth.uid() and context = start_proctor_session.context and status = 'active'
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

  insert into public.proctor_sessions (user_id, context, integrity_tier, consent_given_at, user_agent, status)
  values (auth.uid(), context, tier, now(), current_setting('request.headers', true)::jsonb ->> 'user-agent', 'active')
  returning id into new_id;

  insert into public.proctor_events (session_id, event_type, severity, occurred_at, meta)
  values (new_id, 'session_start', 'info', now(), jsonb_build_object('tier', tier, 'context', context));

  return new_id;
end;
$$;

comment on function public.start_proctor_session(text, smallint) is
  'Creates a proctoring session for auth.uid(), records consent (consent_given_at = now()), abandons+flags any still-active session for the same user+context (concurrent-session detection), and logs session_start. Returns the new session id.';

grant execute on function public.start_proctor_session(text, smallint) to authenticated;

create or replace function public.end_proctor_session(session_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner_id uuid;
  current_status text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select user_id, status into owner_id, current_status
  from public.proctor_sessions
  where id = end_proctor_session.session_id
  for update;

  if owner_id is null then
    raise exception 'Session % not found', session_id;
  end if;

  if owner_id <> auth.uid() then
    raise exception 'Only the session owner may end this session';
  end if;

  if current_status <> 'active' then
    -- Idempotent: ending an already-ended session is a no-op success, not
    -- an error (refresh/double-click races during exam wrap-up shouldn't
    -- surface a scary error to the student).
    return;
  end if;

  update public.proctor_sessions
  set status = 'ended', ended_at = now()
  where id = end_proctor_session.session_id;

  insert into public.proctor_events (session_id, event_type, severity, occurred_at, meta)
  values (end_proctor_session.session_id, 'session_end', 'info', now(), '{}'::jsonb);
end;
$$;

comment on function public.end_proctor_session(uuid) is
  'Owner-only: marks a session ended and logs session_end. No-op (not an error) if already ended/abandoned, for idempotent client retries.';

grant execute on function public.end_proctor_session(uuid) to authenticated;

-- Batch event log, including heartbeats. `events` shape (client-controlled,
-- validated row-by-row below — never trust event_type/severity without the
-- CHECK constraints, and never trust a client-supplied occurred_at as
-- received_at):
--   [{ "event_type": "tab_hidden", "severity": "medium",
--      "occurred_at": "2026-07-04T10:00:00Z", "meta": {} }, ...]
create or replace function public.log_proctor_events(session_id uuid, events jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner_id uuid;
  current_status text;
  evt jsonb;
  has_heartbeat boolean := false;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if events is null or jsonb_typeof(events) <> 'array' then
    raise exception 'events must be a JSON array';
  end if;

  select user_id, status into owner_id, current_status
  from public.proctor_sessions
  where id = log_proctor_events.session_id
  for share;

  if owner_id is null then
    raise exception 'Session % not found', session_id;
  end if;

  if owner_id <> auth.uid() then
    raise exception 'Only the session owner may log events to this session';
  end if;

  if current_status <> 'active' then
    raise exception 'Session % is not active', session_id;
  end if;

  for evt in select * from jsonb_array_elements(events)
  loop
    if not (evt ->> 'event_type' in (
      'tab_hidden', 'tab_visible', 'window_blur', 'window_focus',
      'fullscreen_exit', 'fullscreen_enter', 'copy_attempt', 'paste_attempt',
      'cut_attempt', 'contextmenu', 'connection_lost', 'connection_restored',
      'snapshot_captured', 'camera_lost', 'multi_monitor_detected',
      'page_unload', 'heartbeat', 'session_start', 'session_end',
      'concurrent_session_detected'
    )) then
      raise exception 'Invalid event_type: %', evt ->> 'event_type';
    end if;

    if not (evt ->> 'severity' in ('info', 'low', 'medium', 'high')) then
      raise exception 'Invalid severity: %', evt ->> 'severity';
    end if;

    if evt ->> 'occurred_at' is null then
      raise exception 'occurred_at is required';
    end if;

    insert into public.proctor_events (session_id, event_type, severity, occurred_at, meta)
    values (
      log_proctor_events.session_id,
      evt ->> 'event_type',
      evt ->> 'severity',
      (evt ->> 'occurred_at')::timestamptz,
      coalesce(evt -> 'meta', '{}'::jsonb)
    );

    if evt ->> 'event_type' = 'heartbeat' then
      has_heartbeat := true;
    end if;
  end loop;

  if has_heartbeat then
    update public.proctor_sessions
    set last_heartbeat_at = now()
    where id = log_proctor_events.session_id;
  end if;
end;
$$;

comment on function public.log_proctor_events(uuid, jsonb) is
  'Batch-inserts events for a session the caller owns AND that is still active. Validates event_type/severity server-side against the same CHECK-constrained vocabulary; stamps received_at via each row''s default (client-supplied occurred_at is kept separately as evidence, never trusted as received_at). A heartbeat event also bumps proctor_sessions.last_heartbeat_at.';

grant execute on function public.log_proctor_events(uuid, jsonb) to authenticated;

-- Records a snapshot/clip upload's metadata row once the binary has been
-- uploaded to Storage (storage RLS policies, next migration, gate the
-- upload itself). Owner of an ACTIVE session only — same shape as
-- log_proctor_events.
create or replace function public.record_proctor_media(
  session_id uuid,
  storage_path text,
  kind text,
  captured_at timestamptz
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner_id uuid;
  current_status text;
  new_id bigint;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select user_id, status into owner_id, current_status
  from public.proctor_sessions
  where id = record_proctor_media.session_id
  for share;

  if owner_id is null then
    raise exception 'Session % not found', session_id;
  end if;

  if owner_id <> auth.uid() then
    raise exception 'Only the session owner may record media for this session';
  end if;

  if current_status <> 'active' then
    raise exception 'Session % is not active', session_id;
  end if;

  if kind not in ('snapshot', 'clip') then
    raise exception 'Invalid kind: %', kind;
  end if;

  if storage_path is null or storage_path not like (record_proctor_media.session_id::text || '/%') then
    raise exception 'storage_path must be prefixed with the session id';
  end if;

  insert into public.proctor_media (session_id, storage_path, kind, captured_at)
  values (record_proctor_media.session_id, storage_path, kind, coalesce(captured_at, now()))
  returning id into new_id;

  return new_id;
end;
$$;

comment on function public.record_proctor_media(uuid, text, text, timestamptz) is
  'Records metadata for a snapshot/clip already uploaded to the ''proctoring'' storage bucket. Owner of an ACTIVE session only; storage_path must be prefixed {session_id}/ (also enforced independently by storage RLS on the actual upload).';

grant execute on function public.record_proctor_media(uuid, text, text, timestamptz) to authenticated;
