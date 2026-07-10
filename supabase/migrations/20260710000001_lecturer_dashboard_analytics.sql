-- Analytics phase (lecturer): a single SECURITY DEFINER aggregate RPC for
-- the lecturer dashboard's charts. No arguments to trust — authority is
-- entirely re-derived from auth.uid() + has_role('lecturer') inside the
-- function body, exactly like can_manage_exam and every other RPC in this
-- schema, so this needs no 20260705000006-style EXECUTE lock-down. It IS
-- reachable by any authenticated caller; a student calling it gets a raised
-- exception, not another lecturer's data (see the negative smoke-test note
-- below).
--
-- Scope choice, documented: "the caller's exams" here means STRICTLY
-- owner_id = auth.uid() — deliberately NOT reusing the exams table's own
-- "any lecturer sees any exam" known simplification (exams_select_owner_
-- or_lecturer, 20260705000011). A personal dashboard answering "how is MY
-- teaching load doing" is more useful scoped to ownership than to the
-- platform-wide view admin/super-admin already get from
-- lib/admin/platform-analytics.ts.
--
-- Same hardening posture as every prior migration: `set search_path = ''`,
-- fully-qualified identifiers, stable (read-only).

create or replace function public.lecturer_dashboard_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_exams_by_status jsonb;
  v_attempts_by_status jsonb;
  v_flags_by_severity jsonb;
  v_score_distribution jsonb;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if not public.has_role('lecturer') then
    raise exception 'Only a lecturer, admin, or super_admin may view lecturer dashboard analytics';
  end if;

  -- Exam count by status, owner-scoped.
  select coalesce(jsonb_object_agg(s.status, s.cnt), '{}'::jsonb) into v_exams_by_status
  from (
    select e.status, count(*) as cnt
    from public.exams e
    where e.owner_id = auth.uid()
    group by e.status
  ) s;

  -- Attempt count by status, across the caller's exams.
  select coalesce(jsonb_object_agg(s.status, s.cnt), '{}'::jsonb) into v_attempts_by_status
  from (
    select ea.status, count(*) as cnt
    from public.exam_attempts ea
    join public.exams e on e.id = ea.exam_id
    where e.owner_id = auth.uid()
    group by ea.status
  ) s;

  -- Integrity flags (proctor_events) by severity, across sessions linked to
  -- the caller's exam attempts. This is proctoring signal for THEIR exams
  -- only — a lecturer never sees another lecturer's students' event detail
  -- through this RPC.
  select coalesce(jsonb_object_agg(s.severity, s.cnt), '{}'::jsonb) into v_flags_by_severity
  from (
    select pe.severity, count(*) as cnt
    from public.proctor_events pe
    join public.proctor_sessions ps on ps.id = pe.session_id
    join public.exam_attempts ea on ea.proctor_session_id = ps.id
    join public.exams e on e.id = ea.exam_id
    where e.owner_id = auth.uid()
    group by pe.severity
  ) s;

  -- Score distribution buckets for fully-graded attempts (same status set
  -- get_attempt_result treats as "has a finalized score": submitted/
  -- auto_submitted/terminated/graded, AND needs_manual_grading = false so a
  -- still-partially-graded essay attempt never counts on a stale score).
  select coalesce(jsonb_object_agg(s.bucket, s.cnt), '{}'::jsonb) into v_score_distribution
  from (
    select
      case
        when scored.pct < 50 then '0-49'
        when scored.pct < 60 then '50-59'
        when scored.pct < 70 then '60-69'
        when scored.pct < 80 then '70-79'
        else '80-100'
      end as bucket,
      count(*) as cnt
    from (
      select (ea.auto_score / ea.max_score) * 100 as pct
      from public.exam_attempts ea
      join public.exams e on e.id = ea.exam_id
      where e.owner_id = auth.uid()
        and ea.status in ('submitted', 'auto_submitted', 'terminated', 'graded')
        and ea.needs_manual_grading = false
        and ea.max_score is not null
        and ea.max_score > 0
        and ea.auto_score is not null
    ) scored
    group by bucket
  ) s;

  return jsonb_build_object(
    'exams_by_status', v_exams_by_status,
    'attempts_by_status', v_attempts_by_status,
    'flags_by_severity', v_flags_by_severity,
    'score_distribution', v_score_distribution
  );
end;
$$;

comment on function public.lecturer_dashboard_stats() is
  'Analytics phase: lecturer dashboard aggregates, STRICTLY owner-scoped (owner_id = auth.uid() on exams — not the "any lecturer" known simplification exams'' own SELECT policy uses). Re-derives authority from auth.uid() + has_role(''lecturer'') itself; raises for a student caller rather than returning empty data, so a negative smoke test can assert denial rather than an empty-but-reachable result. Returns {exams_by_status, attempts_by_status, flags_by_severity, score_distribution} as jsonb objects keyed by bucket -> count. No arguments, so nothing for a client to spoof; no EXECUTE lock-down needed (contrast draw_exam_for_attempt).';

grant execute on function public.lecturer_dashboard_stats() to authenticated;
