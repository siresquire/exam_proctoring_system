-- Phase 1.5 (B1): server-enforced violation-threshold auto-termination.
--
-- Adds strike counting to proctor_sessions and a proctor_reports table, and
-- rewrites log_proctor_events so the SERVER (never the client) decides when a
-- session has crossed its violation limit, terminates it, and files a report
-- for later human review (Phase 4 builds the review workflow that fills
-- reviewed_by/reviewed_at/verdict — those columns stay policy-less/blocked
-- for now). Same hardening posture as the rest of the proctor RPCs: security
-- definer, set search_path = '', fully-qualified identifiers, append-only.
--
-- New migration file (dated 20260705...) rather than editing 000006-8, which
-- are already applied/finalized.

-- 1. Extend proctor_sessions ------------------------------------------------

-- Add a new 'terminated' status. The column uses a CHECK constraint (not an
-- enum type) in 000006 — extend it in place: drop the old CHECK and add one
-- that allows the extra value (existing rows are all in the old set, so this
-- is safe).
alter table public.proctor_sessions
  drop constraint proctor_sessions_status_check;

alter table public.proctor_sessions
  add constraint proctor_sessions_status_check
  check (status in ('active', 'ended', 'abandoned', 'terminated'));

alter table public.proctor_sessions
  add column violation_limit smallint not null default 3,
  add column violation_count smallint not null default 0;

comment on column public.proctor_sessions.violation_limit is
  'High-severity strikes tolerated before the server auto-terminates the session (Phase 1.5, default 3). Set at session start.';
comment on column public.proctor_sessions.violation_count is
  'Running count of high-severity events counted toward the limit. Incremented atomically inside log_proctor_events; never client-writable.';

-- 2. proctor_reports --------------------------------------------------------
-- One report per session that reaches a terminal integrity outcome. Filed by
-- the server (log_proctor_events, security definer). Append-only for clients,
-- same posture as proctor_events / audit_log: revoke direct DML + trap
-- update/delete with a trigger.

create table public.proctor_reports (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null unique references public.proctor_sessions (id) on delete cascade,
  -- 'violation_limit_reached' for the auto-termination path; kept generic so
  -- Phase 4 (manual escalation, timing analysis, etc.) can reuse the table.
  reason text not null,
  -- Event counts by severity and by type at termination time, e.g.
  -- {"by_severity": {"high": 3, ...}, "by_type": {"tab_hidden": 2, ...}}.
  summary jsonb not null default '{}'::jsonb,
  generated_at timestamptz not null default now(),
  status text not null default 'pending_review',
  -- Phase 4 review workflow fills these; no client UPDATE policy exists yet
  -- (deliberately blocked until the review workspace is built).
  reviewed_by uuid references auth.users (id),
  reviewed_at timestamptz,
  verdict text
);

comment on table public.proctor_reports is
  'One report per session that reached a terminal integrity outcome (Phase 1.5: violation limit). Filed by log_proctor_events (security definer). Append-only for clients; reviewed_by/reviewed_at/verdict are filled by the Phase 4 review workspace (no client UPDATE policy yet).';
comment on column public.proctor_reports.reason is
  'Why the report was filed. ''violation_limit_reached'' for the auto-termination path; column is generic for future reasons.';
comment on column public.proctor_reports.summary is
  'Event counts by severity and by type at the moment the report was generated.';

create index proctor_reports_session_id_idx on public.proctor_reports (session_id);
create index proctor_reports_status_idx on public.proctor_reports (status);

revoke insert, update, delete on public.proctor_reports from anon, authenticated;

create or replace function public.proctor_reports_immutable()
returns trigger
language plpgsql
as $$
begin
  raise exception 'proctor_reports is append-only: % is not permitted', tg_op;
end;
$$;

create trigger proctor_reports_no_update
  before update on public.proctor_reports
  for each row
  execute function public.proctor_reports_immutable();

create trigger proctor_reports_no_delete
  before delete on public.proctor_reports
  for each row
  execute function public.proctor_reports_immutable();

-- 3. RLS on proctor_reports -------------------------------------------------
-- SELECT: the session owner (student sees a report exists for THEIR OWN
-- session only) OR lecturer_or_higher (has_role('lecturer') — super_admin
-- passes everything). "Any lecturer" for now, same known simplification as
-- proctor_sessions/events (Phase 4 scopes to the lecturer who owns the exam
-- once exams/class ownership exist). No INSERT/UPDATE/DELETE policy for any
-- client role: the server-side RPC (security definer) is the only writer.

alter table public.proctor_reports enable row level security;
alter table public.proctor_reports force row level security;

create policy proctor_reports_select_own
  on public.proctor_reports
  for select
  to authenticated
  using (
    exists (
      select 1 from public.proctor_sessions s
      where s.id = proctor_reports.session_id and s.user_id = auth.uid()
    )
  );

create policy proctor_reports_select_lecturer_or_higher
  on public.proctor_reports
  for select
  to authenticated
  using (public.has_role('lecturer'));

-- No INSERT/UPDATE/DELETE policies (append-only via server RPC only).

-- 4. Rewrite log_proctor_events with server-side violation enforcement ------
-- Returns a small json so the client learns about termination + its strike
-- standing from its next batch-upload response:
--   { accepted, session_status, violation_count, violation_limit }
-- Atomic/race-safe: takes FOR UPDATE on the session row up front, so
-- concurrent batches serialize and the count/termination decision can never
-- interleave.
--
-- Return type changes from void (000006) to jsonb, so the old function must
-- be dropped first — CREATE OR REPLACE cannot change a function's return type.
drop function if exists public.log_proctor_events(uuid, jsonb);

create or replace function public.log_proctor_events(session_id uuid, events jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner_id uuid;
  current_status text;
  v_violation_count smallint;
  v_violation_limit smallint;
  evt jsonb;
  has_heartbeat boolean := false;
  high_in_batch smallint := 0;
  accepted smallint := 0;
  by_severity jsonb;
  by_type jsonb;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if events is null or jsonb_typeof(events) <> 'array' then
    raise exception 'events must be a JSON array';
  end if;

  -- FOR UPDATE (not FOR SHARE): we may mutate this row (violation_count,
  -- status) below, and we need concurrent batches to serialize so two
  -- overlapping uploads can't both read violation_count = 2 and each push
  -- it to 3 (double-terminate / miscount). Row lock makes the read-count-
  -- decide-write sequence atomic.
  select user_id, status, violation_count, violation_limit
    into owner_id, current_status, v_violation_count, v_violation_limit
  from public.proctor_sessions
  where id = log_proctor_events.session_id
  for update;

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
      'concurrent_session_detected', 'identity_mismatch', 'session_terminated'
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

    accepted := accepted + 1;

    if evt ->> 'event_type' = 'heartbeat' then
      has_heartbeat := true;
    end if;

    -- Count high-severity events toward the violation limit. The
    -- server-generated session_terminated event (appended below) is itself
    -- high but must NOT count — we only tally client-reported integrity
    -- signals, which never carry that type.
    if evt ->> 'severity' = 'high' and evt ->> 'event_type' <> 'session_terminated' then
      high_in_batch := high_in_batch + 1;
    end if;
  end loop;

  if has_heartbeat then
    update public.proctor_sessions
    set last_heartbeat_at = now()
    where id = log_proctor_events.session_id;
  end if;

  -- Atomically bump the strike count for the high-severity events in this
  -- batch (row already locked FOR UPDATE above).
  if high_in_batch > 0 then
    v_violation_count := v_violation_count + high_in_batch;
    update public.proctor_sessions
    set violation_count = v_violation_count
    where id = log_proctor_events.session_id;
  end if;

  -- Threshold reached -> terminate + file a report.
  if v_violation_count >= v_violation_limit then
    -- Build the summary counts (by severity + by type) across the whole
    -- session at termination time.
    select
      coalesce(jsonb_object_agg(severity, cnt), '{}'::jsonb)
    into by_severity
    from (
      select pe.severity, count(*) as cnt
      from public.proctor_events pe
      where pe.session_id = log_proctor_events.session_id
      group by pe.severity
    ) s;

    select
      coalesce(jsonb_object_agg(event_type, cnt), '{}'::jsonb)
    into by_type
    from (
      select pe.event_type, count(*) as cnt
      from public.proctor_events pe
      where pe.session_id = log_proctor_events.session_id
      group by pe.event_type
    ) t;

    update public.proctor_sessions
    set status = 'terminated', ended_at = now()
    where id = log_proctor_events.session_id;
    current_status := 'terminated';

    -- Append the terminal event (high severity; does NOT count toward the
    -- limit — see the loop guard above).
    insert into public.proctor_events (session_id, event_type, severity, occurred_at, meta)
    values (
      log_proctor_events.session_id,
      'session_terminated',
      'high',
      now(),
      jsonb_build_object(
        'reason', 'violation_limit_reached',
        'violation_count', v_violation_count,
        'violation_limit', v_violation_limit,
        'by_severity', by_severity,
        'by_type', by_type
      )
    );

    -- File the report (session_id is unique; a session terminates once).
    -- ON CONFLICT ON CONSTRAINT (not a bare column list): plpgsql resolves a
    -- bare `session_id` inside a column list against the *parameter* of
    -- the same name, not the table column, raising "ambiguous" — the named
    -- unique constraint sidesteps that entirely (same class of bug as
    -- 20260704000008's start_proctor_session fix).
    insert into public.proctor_reports (session_id, reason, summary)
    values (
      log_proctor_events.session_id,
      'violation_limit_reached',
      jsonb_build_object(
        'violation_count', v_violation_count,
        'violation_limit', v_violation_limit,
        'by_severity', by_severity,
        'by_type', by_type
      )
    )
    on conflict on constraint proctor_reports_session_id_key do nothing;
  end if;

  return jsonb_build_object(
    'accepted', accepted,
    'session_status', current_status,
    'violation_count', v_violation_count,
    'violation_limit', v_violation_limit
  );
end;
$$;

comment on function public.log_proctor_events(uuid, jsonb) is
  'Batch-inserts events for a session the caller owns AND that is still active. Validates event_type/severity server-side. Counts high-severity events toward the session violation_limit (atomic, row-locked); on reaching the limit it terminates the session (status=terminated, ended_at=now), appends a session_terminated event, and files a proctor_reports row — none of which a hostile client can dodge. Returns { accepted, session_status, violation_count, violation_limit } so the client learns its strike standing and any termination from its next upload.';

grant execute on function public.log_proctor_events(uuid, jsonb) to authenticated;
