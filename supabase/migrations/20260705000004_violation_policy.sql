-- Phase 1.7: configurable violation policy + display-change detection.
--
-- ANTI-TAMPER FIX: until now, log_proctor_events() trusted the client's
-- self-reported `severity` for BOTH storage AND strike-counting (only
-- event_type/occurred_at/shape were server-validated — see 20260705000003).
-- A hostile client could report every event as severity 'info' and never
-- accumulate a strike. From this migration onward, severity (and whether an
-- event counts toward the violation limit) is assigned SERVER-SIDE, from a
-- policy snapshotted onto the session at start_proctor_session() time. The
-- client may still send a `severity` field (kept for backward-compatible
-- payload shape / local optimistic display) but it is READ NEVER — the
-- server looks up event_type in the session's stored policy instead.
--
-- User decision (PLAN.md Phase 1.7): by default EVERY violation-type event
-- counts toward the 3-strike termination ("students are supposed to stay on
-- the screen and just answer the questions"). Only genuine lifecycle/info
-- events (heartbeat, snapshot_captured, tab_visible, etc.) are exempt by
-- default. Lecturers/admins/super_admins may override per event type via a
-- policy passed to start_proctor_session (validated + merged over the
-- default here, server-side).
--
-- New migration file (dated 20260705000004) rather than editing 000001/
-- 000002/000003 (already applied/finalized). Extends:
--   1. proctor_events.event_type CHECK (+ display_configuration_changed).
--   2. proctor_sessions gains violation_policy jsonb (snapshot at start).
--   3. public.default_violation_policy() — single source of truth for
--      defaults, reusable by both start_proctor_session and any future
--      admin-facing "what would the default be" UI.
--   4. start_proctor_session gains a `violation_policy jsonb default null`
--      param: caller-supplied PARTIAL overrides, validated + merged over
--      default_violation_policy(), stored as the session's snapshot.
--   5. log_proctor_events rewritten to assign severity/counts from the
--      session's stored violation_policy instead of the client payload.

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
      'multiple_faces_detected',
      -- Phase 1.7: a display was plugged in / unplugged / resized mid-session
      -- (screen.isExtended flipping, or the display count/geometry changing)
      -- AFTER the session already started. Distinct from
      -- multi_monitor_detected, which is the one-shot START-of-session
      -- observation ("this device already has 2 displays") and is NOT itself
      -- a violation. See collectors.ts collectDisplayChange.
      'display_configuration_changed'
    )
  );

-- 2. public.default_violation_policy() -------------------------------------
-- The single source of truth for "what counts by default". Returns a jsonb
-- object: event_type -> { "severity": "info"|"low"|"medium"|"high",
-- "counts": boolean }. IMMUTABLE: pure function of no inputs, same result
-- every call — lets the planner treat it as a constant and lets
-- start_proctor_session call it cheaply as a merge base every time.
--
-- Policy (PLAN.md Phase 1.7, user directive):
--   * ALL violation-type signals count by default, severity high:
--     tab_hidden, window_blur, fullscreen_exit, copy_attempt, paste_attempt,
--     cut_attempt, contextmenu, camera_lost, multiple_faces_detected,
--     display_configuration_changed, concurrent_session_detected,
--     identity_mismatch.
--   * counts=true, severity medium: no_face_detected, connection_lost.
--     connection_lost counts by default per the user directive — the
--     fairness note lives in the UI (policy editor), not here: lecturers
--     running low-bandwidth/mobile-data cohorts are told to disable it.
--   * counts=false, severity info: benign lifecycle/observation events —
--     tab_visible, window_focus, fullscreen_enter, connection_restored,
--     snapshot_captured, heartbeat, session_start, session_end,
--     page_unload, multi_monitor_detected (the START-of-session
--     observation; the mid-exam CHANGE event, display_configuration_changed,
--     is the violation, not this one).
--   * session_terminated: counts=false, severity high. Server-generated only
--     (log_proctor_events appends it directly, bypassing the policy lookup
--     entirely) — listed here for completeness/documentation and so a
--     defensive policy lookup on this type never returns NULL.
create or replace function public.default_violation_policy()
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'tab_hidden',                    jsonb_build_object('severity', 'high', 'counts', true),
    'window_blur',                   jsonb_build_object('severity', 'high', 'counts', true),
    'fullscreen_exit',                jsonb_build_object('severity', 'high', 'counts', true),
    'copy_attempt',                   jsonb_build_object('severity', 'high', 'counts', true),
    'paste_attempt',                  jsonb_build_object('severity', 'high', 'counts', true),
    'cut_attempt',                    jsonb_build_object('severity', 'high', 'counts', true),
    'contextmenu',                    jsonb_build_object('severity', 'high', 'counts', true),
    'camera_lost',                    jsonb_build_object('severity', 'high', 'counts', true),
    'multiple_faces_detected',        jsonb_build_object('severity', 'high', 'counts', true),
    'display_configuration_changed',  jsonb_build_object('severity', 'high', 'counts', true),
    'concurrent_session_detected',    jsonb_build_object('severity', 'high', 'counts', true),
    'identity_mismatch',              jsonb_build_object('severity', 'high', 'counts', true),

    'no_face_detected',               jsonb_build_object('severity', 'medium', 'counts', true),
    'connection_lost',                jsonb_build_object('severity', 'medium', 'counts', true),

    'tab_visible',                    jsonb_build_object('severity', 'info', 'counts', false),
    'window_focus',                   jsonb_build_object('severity', 'info', 'counts', false),
    'fullscreen_enter',               jsonb_build_object('severity', 'info', 'counts', false),
    'connection_restored',            jsonb_build_object('severity', 'info', 'counts', false),
    'snapshot_captured',              jsonb_build_object('severity', 'info', 'counts', false),
    'heartbeat',                      jsonb_build_object('severity', 'info', 'counts', false),
    'session_start',                  jsonb_build_object('severity', 'info', 'counts', false),
    'session_end',                    jsonb_build_object('severity', 'info', 'counts', false),
    'page_unload',                    jsonb_build_object('severity', 'info', 'counts', false),
    'multi_monitor_detected',         jsonb_build_object('severity', 'info', 'counts', false),

    'session_terminated',             jsonb_build_object('severity', 'high', 'counts', false)
  );
$$;

comment on function public.default_violation_policy() is
  'Phase 1.7: single source of truth for the default violation policy (event_type -> {severity, counts}). ALL violation-type signals count toward the 3-strike limit by default (user directive); only benign lifecycle/observation events are exempt. start_proctor_session merges caller-supplied overrides over this and snapshots the result onto proctor_sessions.violation_policy.';

-- 3. proctor_sessions.violation_policy --------------------------------------

alter table public.proctor_sessions
  add column violation_policy jsonb not null default '{}'::jsonb;

comment on column public.proctor_sessions.violation_policy is
  'Phase 1.7: SNAPSHOT (taken at start_proctor_session time) of event_type -> {severity, counts}, merged from default_violation_policy() + any caller-supplied overrides. log_proctor_events reads severity/counts from THIS column, never from the client payload — server-assigned, tamper-proof. Backfilled to {} for rows created before this migration (none exist in practice; the column default only matters for schema completeness).';

-- Backfill any pre-existing rows (none expected in a fresh local/dev stack,
-- but keeps the column meaningfully populated rather than {} if this ever
-- runs against a database with real Phase-1.x demo data already in it).
update public.proctor_sessions
set violation_policy = public.default_violation_policy()
where violation_policy = '{}'::jsonb;

-- 4. start_proctor_session gains a violation_policy override param ---------
-- New optional param `violation_policy jsonb default null`: the caller may
-- pass a PARTIAL object of overrides (only the event types it wants to
-- change) — anything omitted keeps the default_violation_policy() value.
-- Validated strictly: unknown event_type keys, invalid severity values, or
-- a non-boolean `counts` all raise rather than silently ignoring garbage
-- (a lecturer fat-fingering a policy should get an error, not a silently
-- wrong exam).
--
-- Today (Phase 1.7 demo), the SESSION OWNER (the student, via the pre-
-- session policy editor UI) passes this directly, since there is no exam
-- entity yet to own the policy. Phase 3/4 note: once exams exist, the
-- lecturer/admin/super_admin will set the policy ONCE per exam (stored on
-- the exams row) and SERVER CODE (not the student's client) will pass it
-- into start_proctor_session when the student begins their attempt — the
-- `violation_policy` param signature already supports that call shape
-- unchanged; only the caller changes.
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
  v_context text := context;
  v_tier smallint := tier;
  v_claimed text := claimed_index_number;
  v_attested boolean := attested;
  v_overrides jsonb := violation_policy;
  v_policy jsonb;
  v_key text;
  v_entry jsonb;
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

  -- Build + validate the merged violation policy. Start from the server's
  -- defaults, then apply caller overrides ONE KEY AT A TIME so we can
  -- reject garbage per-key rather than trusting jsonb `||` merge to let
  -- anything through.
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

      -- Merge just this key's provided fields over the default entry (a
      -- caller may override only `counts` and leave `severity` at its
      -- default, or vice versa).
      v_policy := jsonb_set(
        v_policy,
        array[v_key],
        (v_policy -> v_key) || v_entry
      );
    end loop;
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
    (user_id, context, integrity_tier, consent_given_at, user_agent, status,
     claimed_index_number, attested_at, violation_policy)
  values (
    auth.uid(),
    v_context,
    v_tier,
    now(),
    current_setting('request.headers', true)::jsonb ->> 'user-agent',
    'active',
    v_claimed,
    now(),
    v_policy
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

comment on function public.start_proctor_session(text, smallint, text, boolean, jsonb) is
  'Creates a proctoring session for auth.uid(). Refuses unless attested = true. Merges an optional caller-supplied violation_policy (partial overrides, strictly validated: known event types only, valid severity values, boolean counts) over default_violation_policy() and snapshots the result onto proctor_sessions.violation_policy — log_proctor_events reads severity/counts from that snapshot, never from client event payloads. Records consent + attested_at + claimed_index_number, abandons+flags any still-active session for the same user+context, logs session_start, and flags identity_mismatch on registry mismatch. Phase 1.7 note: today the session owner (student, via the demo''s policy editor) passes violation_policy directly; once exams exist (Phase 3/4), server code will pass the exam''s lecturer/admin-configured policy instead — this signature does not need to change for that. Returns the new session id.';

grant execute on function public.start_proctor_session(text, smallint, text, boolean, jsonb) to authenticated;

-- Drop the older 4-arg signature so callers must go through validation
-- (the previous form would silently create sessions with no policy
-- override support, which is fine, but keeping two overloads around
-- invites callers to skip the new param entirely by accident during
-- refactors — one canonical signature going forward).
drop function if exists public.start_proctor_session(text, smallint, text, boolean);

-- 5. Rewrite log_proctor_events: server-assigned severity + counting -------
-- ANTI-TAMPER FIX (see top-of-file comment): severity and strike-counting
-- are now derived from the session's stored violation_policy, NOT from the
-- client-supplied `severity` field on each event. The client may still send
-- a `severity` value in the payload shape (ignored) for backward
-- compatibility with in-flight/offline-buffered events queued by an older
-- client build.
--
-- Same jsonb return + row-lock structure as 20260705000003's version — only
-- the severity/counts derivation changes. Return type is unchanged (jsonb),
-- so CREATE OR REPLACE is sufficient.
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
  v_policy jsonb;
  evt jsonb;
  v_event_type text;
  v_policy_entry jsonb;
  v_severity text;
  v_counts boolean;
  has_heartbeat boolean := false;
  counted_in_batch smallint := 0;
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
  select user_id, status, violation_count, violation_limit, violation_policy
    into owner_id, current_status, v_violation_count, v_violation_limit, v_policy
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

  -- Sessions created before this migration (or with a never-populated
  -- policy for any other reason) fall back to the server default rather
  -- than an empty/absent policy silently assigning nothing.
  if v_policy is null or v_policy = '{}'::jsonb then
    v_policy := public.default_violation_policy();
  end if;

  for evt in select * from jsonb_array_elements(events)
  loop
    v_event_type := evt ->> 'event_type';

    if not (v_event_type in (
      'tab_hidden', 'tab_visible', 'window_blur', 'window_focus',
      'fullscreen_exit', 'fullscreen_enter', 'copy_attempt', 'paste_attempt',
      'cut_attempt', 'contextmenu', 'connection_lost', 'connection_restored',
      'snapshot_captured', 'camera_lost', 'multi_monitor_detected',
      'page_unload', 'heartbeat', 'session_start', 'session_end',
      'concurrent_session_detected', 'identity_mismatch', 'session_terminated',
      'no_face_detected', 'multiple_faces_detected', 'display_configuration_changed'
    )) then
      raise exception 'Invalid event_type: %', v_event_type;
    end if;

    -- Client-supplied severity, if present, is READ NEVER (anti-tamper —
    -- see top-of-file comment). Still validated defensively for payload
    -- shape/version compatibility if some caller happens to omit it.
    if evt ? 'severity' and not (evt ->> 'severity' in ('info', 'low', 'medium', 'high')) then
      raise exception 'Invalid severity: %', evt ->> 'severity';
    end if;

    if evt ->> 'occurred_at' is null then
      raise exception 'occurred_at is required';
    end if;

    -- Server-assigned severity + counts: look up this event_type in the
    -- session's policy snapshot, falling back to the server default entry,
    -- then to a hard-coded 'info'/false floor so a lookup miss can never
    -- silently escalate to counting.
    v_policy_entry := v_policy -> v_event_type;
    if v_policy_entry is null then
      v_policy_entry := public.default_violation_policy() -> v_event_type;
    end if;

    if v_policy_entry is not null then
      v_severity := coalesce(v_policy_entry ->> 'severity', 'info');
      v_counts := coalesce((v_policy_entry -> 'counts')::text::boolean, false);
    else
      v_severity := 'info';
      v_counts := false;
    end if;

    insert into public.proctor_events (session_id, event_type, severity, occurred_at, meta)
    values (
      log_proctor_events.session_id,
      v_event_type,
      v_severity,
      (evt ->> 'occurred_at')::timestamptz,
      coalesce(evt -> 'meta', '{}'::jsonb)
    );

    accepted := accepted + 1;

    if v_event_type = 'heartbeat' then
      has_heartbeat := true;
    end if;

    -- Count toward the violation limit per policy. session_terminated is
    -- never client-reported (the server appends it below, bypassing this
    -- loop entirely) but the policy entry is counts=false regardless, as a
    -- second line of defense.
    if v_counts and v_event_type <> 'session_terminated' then
      counted_in_batch := counted_in_batch + 1;
    end if;
  end loop;

  if has_heartbeat then
    update public.proctor_sessions
    set last_heartbeat_at = now()
    where id = log_proctor_events.session_id;
  end if;

  -- Atomically bump the strike count for the policy-counted events in this
  -- batch (row already locked FOR UPDATE above).
  if counted_in_batch > 0 then
    v_violation_count := v_violation_count + counted_in_batch;
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
    -- limit — session_terminated's policy entry is counts=false and this
    -- insert also bypasses the counting loop above entirely).
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
  'Phase 1.7 ANTI-TAMPER FIX: severity and strike-counting are assigned SERVER-SIDE from the session''s violation_policy snapshot (set at start_proctor_session), never from the client-supplied severity field — a hostile client can no longer under-report severity to dodge strikes. Batch-inserts events for a session the caller owns AND that is still active; validates event_type server-side. On reaching violation_limit it terminates the session (status=terminated, ended_at=now), appends a session_terminated event (never counted), and files a proctor_reports row. Returns { accepted, session_status, violation_count, violation_limit }.';

grant execute on function public.log_proctor_events(uuid, jsonb) to authenticated;
