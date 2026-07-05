-- Phase 1.6: client-side face-presence detection (no_face_detected,
-- multiple_faces_detected) — server-side vocabulary extension only.
--
-- Two new event types the proctor-core engine can now emit
-- (packages/proctor-core/src/types.ts ProctorEvent union):
--   * no_face_detected        — debounced client-side (N consecutive
--                               no-face snapshots; see engine.ts
--                               noFaceThreshold), so what reaches the
--                               server is already a de-noised signal.
--                               Severity defaults to 'medium' but is
--                               overridable by the host app.
--   * multiple_faces_detected — not debounced client-side (2+ faces in a
--                               single snapshot). Severity defaults to
--                               'high'.
-- Both remain a soft signal that only ever feeds the same human-review
-- pipeline as every other proctor_events row — see docs/RESEARCH.md §3 on
-- face-detector bias (low light, darker skin tones) for why this is
-- debounced/reviewer-gated rather than an instant fail, and PLAN.md Phase
-- 1.6 for the requirement itself.
--
-- New migration file (dated 20260705000003) rather than editing 000001/
-- 000002 (already applied/finalized) or 000006 (same). Extends:
--   1. the proctor_events.event_type CHECK constraint (drop + recreate,
--      same set as 20260705000002 plus the two new values), and
--   2. log_proctor_events' inline validation IN-list (recreate the
--      function — CREATE OR REPLACE is fine here since 20260705000001's
--      jsonb return type is unchanged; everything else is copied exactly
--      from that migration's version, only the IN-list gains two values).

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
      'session_terminated',
      'no_face_detected',
      'multiple_faces_detected'
    )
  );

-- 2. Recreate log_proctor_events with the two new event types accepted -----
-- Identical to 20260705000001's version (jsonb-returning, violation-limit
-- enforcement, atomic row lock) — the ONLY change is the event_type IN-list
-- inside the validation loop gaining 'no_face_detected' and
-- 'multiple_faces_detected'. Return type is unchanged (jsonb), so
-- CREATE OR REPLACE is sufficient — no DROP needed this time.

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
      'concurrent_session_detected', 'identity_mismatch', 'session_terminated',
      'no_face_detected', 'multiple_faces_detected'
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
  'Batch-inserts events for a session the caller owns AND that is still active. Validates event_type/severity server-side. Counts high-severity events toward the session violation_limit (atomic, row-locked); on reaching the limit it terminates the session (status=terminated, ended_at=now), appends a session_terminated event, and files a proctor_reports row — none of which a hostile client can dodge. Returns { accepted, session_status, violation_count, violation_limit } so the client learns its strike standing and any termination from its next upload. Phase 1.6: event_type vocabulary now also accepts no_face_detected/multiple_faces_detected (client-side face-presence detection).';
