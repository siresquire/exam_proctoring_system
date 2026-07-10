-- Analytics phase (student): a single SECURITY DEFINER aggregate RPC for the
-- student dashboard's "Your results" section. Owner-only (student_id =
-- auth.uid(), re-derived server-side, never a client-supplied id — there is
-- no id parameter on this function at all) AND release-gated using the
-- EXACT SAME condition get_attempt_result (20260705000013) uses: this is the
-- same answer/score-secrecy invariant as the exam room — a score must never
-- reach the student before the lecturer's results_release policy allows it,
-- regardless of which RPC is asking.
--
-- Same hardening posture as every prior migration: `set search_path = ''`,
-- fully-qualified identifiers, stable (read-only), no EXECUTE lock-down
-- needed (no arguments to trust — same reasoning as lecturer_dashboard_stats
-- in the prior migration).

create or replace function public.student_dashboard_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_released_results jsonb;
  v_upcoming_count int;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  -- Released results: one row per the CALLER's OWN attempt (student_id =
  -- auth.uid() — never another student's), only for exams whose
  -- results_release condition is actually satisfied right now. Mirrors
  -- get_attempt_result's release gate exactly (immediate: always once the
  -- attempt has a finalized score; after_close: exam closed or now() >
  -- closes_at; manual: results_released_at is set) — before that point, no
  -- row for that exam appears here at all, not even a hidden/placeholder
  -- one. needs_manual_grading = false additionally excludes a
  -- still-partially-graded essay attempt, so a partial/incomplete score is
  -- never shown as if final.
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'exam_id', x.exam_id,
        'exam_title', x.title,
        'submitted_at', x.submitted_at,
        'score_pct', round((x.auto_score / x.max_score) * 100, 1)
      )
      order by x.submitted_at desc
    ),
    '[]'::jsonb
  )
  into v_released_results
  from (
    select
      e.id as exam_id,
      e.title,
      ea.submitted_at,
      ea.auto_score,
      ea.max_score
    from public.exam_attempts ea
    join public.exams e on e.id = ea.exam_id
    where ea.student_id = auth.uid()
      and ea.status in ('submitted', 'auto_submitted', 'terminated', 'graded')
      and ea.needs_manual_grading = false
      and ea.max_score is not null
      and ea.max_score > 0
      and ea.auto_score is not null
      and (
        case coalesce(e.results_release, 'after_close')
          when 'immediate' then true
          when 'after_close' then (
            e.status = 'closed'
            or (e.closes_at is not null and now() > e.closes_at)
          )
          when 'manual' then e.results_released_at is not null
          else false
        end
      )
  ) x;

  -- Upcoming/available exams: published, within [opens_at, closes_at], and
  -- the caller is a class_members row for the exam's class — the same gate
  -- exams_select_published_open_enrolled (20260705000011) applies, re-
  -- implemented here since a SECURITY DEFINER function bypasses RLS and
  -- must therefore re-derive the same filter explicitly rather than rely on
  -- it.
  select count(*) into v_upcoming_count
  from public.exams e
  join public.class_members cm on cm.class_id = e.class_id and cm.student_id = auth.uid()
  where e.status = 'published'
    and (e.opens_at is null or e.opens_at <= now())
    and (e.closes_at is null or e.closes_at >= now());

  return jsonb_build_object(
    'released_results', v_released_results,
    'upcoming_exams_count', v_upcoming_count
  );
end;
$$;

comment on function public.student_dashboard_stats() is
  'Analytics phase: student dashboard aggregates. Owner-only (student_id = auth.uid(), no id argument exists to spoof) AND release-gated using the identical condition get_attempt_result uses — never returns an unreleased exam''s score, and never another student''s results. Returns {released_results: [{exam_id, exam_title, submitted_at, score_pct}], upcoming_exams_count} as jsonb. No EXECUTE lock-down needed (no arguments to trust).';

grant execute on function public.student_dashboard_stats() to authenticated;
