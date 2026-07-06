-- Phase 3d-ii: proctored exam room by tier, server-side termination tie,
-- manual essay grading, results release.
--
-- Scope (PLAN.md "Phase 3d" bullet + integrity tiers T1..T4): this migration
-- wires the T1-only exam room from 20260705000012 up to the real proctoring
-- engine for tier >= 2, ties a proctor session's server-decided termination
-- to the linked exam_attempts row (tamper-proof — no client cooperation
-- needed), adds manual essay grading + finalization, and results-release
-- gating including the ONE RPC that may ever hand a student a correct
-- answer. The full review workspace (video timeline, per-flag verdicts,
-- appeals) is explicitly NOT built here — Phase 4, per the task brief.
--
-- Same security posture as every migration before it: RLS enabled + forced
-- on every table, security-definer RPCs with `set search_path = ''`,
-- authority re-derived from auth.uid()/has_role()/can_manage_exam() rather
-- than trusted from the client, and the 20260705000006 EXECUTE-revoke
-- pattern applied to every new answer-adjacent/trusting helper.

-- 1. exam_attempts.proctor_session_id ----------------------------------------

alter table public.exam_attempts
  add column proctor_session_id uuid references public.proctor_sessions (id) on delete set null;

comment on column public.exam_attempts.proctor_session_id is
  'Phase 3d-ii: the proctor_sessions row started for this attempt when the exam''s integrity_tier >= 2 (context = ''exam:''||attempt_id). NULL for tier 1 (no camera/engine, server-side-only anti-cheat as before) or if session creation somehow failed. Set once, at start_exam_attempt time, by the same trusted path forms_exams uses (_create_proctor_session with the EXAM''s tier+policy, never client-supplied). ON DELETE SET NULL: deleting a session (should never happen in practice — proctor_sessions has no client DELETE policy) must not cascade into losing attempt history.';

create index exam_attempts_proctor_session_id_idx on public.exam_attempts (proctor_session_id) where proctor_session_id is not null;

-- 2. start_exam_attempt: create a linked proctor session for tier >= 2 ------
-- Same signature/return type as 20260705000012 (uuid, text, boolean ->
-- uuid) so CREATE OR REPLACE is sufficient. Behavior is identical for
-- everything already covered by the Phase 3d-i smoke tests (t1-t27) EXCEPT
-- that a fresh attempt on a tier>=2 exam now also creates a linked
-- proctor_sessions row and stores its id. The RESUME path (an in_progress
-- attempt already exists) is unchanged — it does not spin up a second
-- session; the original session id (if any) stays linked, and the client is
-- expected to re-attach its engine to that same session on resume (a
-- disconnected exam room reloading get_attempt_questions will find
-- proctor_session_id already set — see get_attempt_questions below, which
-- now also returns it).
create or replace function public.start_exam_attempt(
  exam_id uuid,
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
  v_existing_id uuid;
  v_existing_status text;
  v_any_prior_id uuid;
  v_seed text;
  v_draw jsonb;
  v_section jsonb;
  v_question jsonb;
  v_paper jsonb := '[]'::jsonb;
  v_section_slots jsonb;
  v_slot_index int;
  v_question_ref text;
  v_max_score numeric := 0;
  v_multiplier numeric := 1.0;
  v_effective_minutes numeric;
  v_new_id uuid;
  v_proctor_session_id uuid;
  v_claimed text := nullif(trim(coalesce(claimed_index_number, '')), '');
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if attested is not true then
    raise exception 'Identity attestation is required before starting an exam attempt';
  end if;

  select * into v_exam from public.exams where id = start_exam_attempt.exam_id;
  if v_exam.id is null then
    raise exception 'Exam % not found', start_exam_attempt.exam_id;
  end if;

  if v_exam.status <> 'published' then
    raise exception 'This exam is not open for attempts';
  end if;

  if v_exam.opens_at is not null and now() < v_exam.opens_at then
    raise exception 'This exam has not opened yet';
  end if;
  if v_exam.closes_at is not null and now() > v_exam.closes_at then
    raise exception 'This exam is closed';
  end if;

  if v_exam.class_id is null or not exists (
    select 1 from public.class_members cm
    where cm.class_id = v_exam.class_id and cm.student_id = auth.uid()
  ) then
    raise exception 'You are not enrolled in the class this exam is assigned to';
  end if;

  -- Resume: an in_progress attempt already exists for this (exam, student) —
  -- the unique partial index guarantees at most one, so this lookup is safe
  -- without a lock. Its proctor_session_id (if any) stays as-is; the client
  -- reattaches to that same session rather than this function minting a
  -- second one.
  select ea.id, ea.status into v_existing_id, v_existing_status
  from public.exam_attempts ea
  where ea.exam_id = start_exam_attempt.exam_id and ea.student_id = auth.uid() and ea.status = 'in_progress';

  if v_existing_id is not null then
    perform public.log_audit(
      'resume_exam_attempt', 'exam_attempt', v_existing_id::text,
      jsonb_build_object('exam_id', start_exam_attempt.exam_id)
    );
    return v_existing_id;
  end if;

  -- One-attempt-per-exam policy (documented KNOWN SIMPLIFICATION, see this
  -- migration's header comment): refuse a brand new attempt if ANY prior
  -- attempt (terminal or not) exists for this pair.
  select ea.id into v_any_prior_id
  from public.exam_attempts ea
  where ea.exam_id = start_exam_attempt.exam_id and ea.student_id = auth.uid()
  limit 1;

  if v_any_prior_id is not null then
    raise exception 'You have already attempted this exam. Only one attempt is allowed.';
  end if;

  v_seed := gen_random_uuid()::text;
  v_draw := public.draw_exam_for_attempt(start_exam_attempt.exam_id, v_seed);

  -- Mint the per-slot question_ref ("<section_id>:<index>") and accumulate
  -- max_score while freezing the paper, so both the paper structure and the
  -- score total are derived from the exact same draw in one pass.
  for v_section in select * from jsonb_array_elements(v_draw -> 'sections')
  loop
    v_section_slots := '[]'::jsonb;
    v_slot_index := 0;
    for v_question in select * from jsonb_array_elements(v_section -> 'questions')
    loop
      v_question_ref := (v_section ->> 'section_id') || ':' || v_slot_index::text;
      v_section_slots := v_section_slots || jsonb_build_array(
        v_question || jsonb_build_object('question_ref', v_question_ref)
      );
      v_max_score := v_max_score + coalesce(nullif((v_question -> 'body' ->> 'marks'), '')::numeric, 0);
      v_slot_index := v_slot_index + 1;
    end loop;
    v_paper := v_paper || jsonb_build_array(
      jsonb_build_object(
        'section_id', v_section ->> 'section_id',
        'title', v_section ->> 'title',
        'description', v_section -> 'description',
        'questions', v_section_slots
      )
    );
  end loop;

  if v_exam.duration_minutes is not null then
    select coalesce((p.accommodations ->> 'extra_time_multiplier')::numeric, 1.0)
    into v_multiplier
    from public.profiles p
    where p.id = auth.uid();
    v_multiplier := coalesce(v_multiplier, 1.0);
    if v_multiplier <= 0 then
      v_multiplier := 1.0;
    end if;
    v_effective_minutes := v_exam.duration_minutes * v_multiplier;
  end if;

  insert into public.exam_attempts (exam_id, student_id, seed, deadline_at, max_score)
  values (
    start_exam_attempt.exam_id,
    auth.uid(),
    v_seed,
    case
      when v_effective_minutes is null then now() + interval '100 years'
      else now() + (v_effective_minutes || ' minutes')::interval
    end,
    v_max_score
  )
  returning id into v_new_id;

  insert into public.exam_attempt_papers (attempt_id, frozen_paper)
  values (v_new_id, jsonb_build_object('exam_id', start_exam_attempt.exam_id, 'seed', v_seed, 'sections', v_paper));

  -- Phase 3d-ii: for integrity_tier >= 2, start a linked proctor session
  -- using the EXAM's own tier + violation_policy — never anything the
  -- client could supply (there is no tier/policy parameter on this
  -- function's signature at all, exactly the structural guarantee
  -- start_forms_exam_session already relies on). context is scoped to the
  -- ATTEMPT (not the exam) because each attempt is its own proctored
  -- session; 'exam:' || attempt id keeps the prefix convention proctor_
  -- sessions.context already documents while remaining unique per attempt.
  if v_exam.integrity_tier >= 2 then
    v_proctor_session_id := public._create_proctor_session(
      'exam:' || v_new_id::text,
      v_exam.integrity_tier,
      v_exam.violation_policy,
      v_claimed,
      true
    );

    update public.exam_attempts
    set proctor_session_id = v_proctor_session_id
    where id = v_new_id;
  end if;

  perform public.log_audit(
    'start_exam_attempt', 'exam_attempt', v_new_id::text,
    jsonb_build_object(
      'exam_id', start_exam_attempt.exam_id,
      'claimed_index_number', v_claimed,
      'multiplier', v_multiplier,
      'proctor_session_id', v_proctor_session_id
    )
  );

  return v_new_id;
end;
$$;

comment on function public.start_exam_attempt(uuid, text, boolean) is
  'Entry point for taking an exam. Validates: attested=true (identity gate, same spirit as start_proctor_session), exam is published and now() is within [opens_at, closes_at], and the caller is a class_members row for exam.class_id. Resumes an existing in_progress attempt if one exists (idempotent — never duplicates, and does not mint a second proctor session on resume); otherwise enforces the one-attempt-per-exam policy, calls the locked-down draw_exam_for_attempt, mints a stable question_ref per slot, computes deadline_at from exams.duration_minutes scaled by accommodations->>extra_time_multiplier, stores the frozen paper, and — Phase 3d-ii — for integrity_tier >= 2 additionally starts a linked proctor_sessions row via the shared _create_proctor_session helper using the EXAM''s own tier+violation_policy (never client-supplied), storing the new session id on exam_attempts.proctor_session_id. Tier 1 creates no session (server-side-only anti-cheat, unchanged from 3d-i). Returns the attempt id. Audit-logged.';

grant execute on function public.start_exam_attempt(uuid, text, boolean) to authenticated;

-- 3. get_attempt_questions: also surface proctor_session_id + exam tier ------
-- The client needs to know (a) whether to run the proctoring engine at all
-- and (b) which session to attach it to — both on first load AND on resume
-- after a refresh, since the engine is NOT restarted by start_exam_attempt's
-- resume branch. Adding these two fields is purely additive to the returned
-- jsonb shape; nothing existing is removed, so every Phase 3d-i smoke-test
-- assertion on this function's output remains valid unchanged.
create or replace function public.get_attempt_questions(attempt_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_attempt record;
  v_exam record;
  v_paper jsonb;
  v_sanitized_sections jsonb := '[]'::jsonb;
  v_section jsonb;
  v_sanitized_questions jsonb;
  v_question jsonb;
  v_body jsonb;
  v_sanitized_body jsonb;
  v_options jsonb;
  v_sanitized_options jsonb;
  v_opt jsonb;
  v_answers jsonb;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select * into v_attempt from public.exam_attempts where id = get_attempt_questions.attempt_id;
  if v_attempt.id is null then
    raise exception 'Attempt % not found', get_attempt_questions.attempt_id;
  end if;

  if v_attempt.student_id <> auth.uid() then
    raise exception 'You may only view your own attempt';
  end if;

  if v_attempt.status not in ('in_progress', 'submitted', 'auto_submitted', 'graded', 'terminated') then
    raise exception 'This attempt is not accessible';
  end if;

  select integrity_tier into v_exam from public.exams where id = v_attempt.exam_id;

  select frozen_paper into v_paper
  from public.exam_attempt_papers
  where exam_attempt_papers.attempt_id = get_attempt_questions.attempt_id;

  if v_paper is null then
    raise exception 'No paper found for this attempt';
  end if;

  for v_section in select * from jsonb_array_elements(v_paper -> 'sections')
  loop
    v_sanitized_questions := '[]'::jsonb;
    for v_question in select * from jsonb_array_elements(v_section -> 'questions')
    loop
      v_body := v_question -> 'body';

      -- Strip every answer-bearing field regardless of type: correct
      -- (mcq/true_false), accepted + case_sensitive (short_answer),
      -- tolerance (numeric — reveals precision of the correct value even
      -- without the value itself, so it goes too), rubric (essay solution
      -- notes). marks stays (students may see how much a question is
      -- worth). options are kept but each option's own body is already
      -- just {id, text} (see question_versions body shape) — no `correct`
      -- lives on an option itself, it is a top-level array of ids, so
      -- stripping body.correct is sufficient; still rebuild options
      -- explicitly below as a second, redundant belt-and-braces layer.
      v_sanitized_body := v_body - 'correct' - 'accepted' - 'case_sensitive' - 'tolerance' - 'rubric';

      v_options := v_body -> 'options';
      if v_options is not null and jsonb_typeof(v_options) = 'array' then
        v_sanitized_options := '[]'::jsonb;
        for v_opt in select * from jsonb_array_elements(v_options)
        loop
          v_sanitized_options := v_sanitized_options || jsonb_build_array(
            jsonb_build_object('id', v_opt ->> 'id', 'text', v_opt ->> 'text')
          );
        end loop;
        v_sanitized_body := jsonb_set(v_sanitized_body, '{options}', v_sanitized_options);
      end if;

      v_sanitized_questions := v_sanitized_questions || jsonb_build_array(
        jsonb_build_object(
          'question_ref', v_question ->> 'question_ref',
          'question_id', v_question ->> 'question_id',
          'version_id', v_question ->> 'version_id',
          'type', v_question ->> 'type',
          'prompt', v_question ->> 'prompt',
          'body', v_sanitized_body
        )
      );
    end loop;

    v_sanitized_sections := v_sanitized_sections || jsonb_build_array(
      jsonb_build_object(
        'section_id', v_section ->> 'section_id',
        'title', v_section ->> 'title',
        'description', v_section -> 'description',
        'questions', v_sanitized_questions
      )
    );
  end loop;

  select coalesce(jsonb_agg(jsonb_build_object(
    'question_ref', ea.question_ref,
    'response', ea.response,
    'flagged', ea.flagged
  )), '[]'::jsonb)
  into v_answers
  from public.exam_answers ea
  where ea.attempt_id = get_attempt_questions.attempt_id;

  return jsonb_build_object(
    'attempt_id', v_attempt.id,
    'status', v_attempt.status,
    'started_at', v_attempt.started_at,
    'deadline_at', v_attempt.deadline_at,
    'server_now', now(),
    'sections', v_sanitized_sections,
    'answers', v_answers,
    'integrity_tier', coalesce(v_exam.integrity_tier, 1),
    'proctor_session_id', v_attempt.proctor_session_id
  );
end;
$$;

comment on function public.get_attempt_questions(uuid) is
  'THE sanitized delivery RPC — owner-only, attempt must be in a readable status (now includes ''terminated'' so a student can see the calm post-termination summary). Strips body.correct/accepted/case_sensitive/tolerance/rubric from EVERY question slot server-side before returning. Phase 3d-ii: also returns integrity_tier (from the parent exam) and proctor_session_id, so the exam room client knows whether to attach the proctoring engine at all and, on a page-refresh resume, which existing session to reattach to rather than starting a second one. NEVER returns exam_attempt_papers'' raw frozen_paper.';

grant execute on function public.get_attempt_questions(uuid) to authenticated;

-- 4. Termination tie: proctor_sessions -> exam_attempts, TRIGGER-DRIVEN ------
-- The single most important property of this section: a student hitting the
-- violation limit gets their attempt closed and partially graded WITHOUT any
-- client cooperation. log_proctor_events (20260705000004) already
-- terminates the session server-side when violation_count reaches
-- violation_limit — this trigger reacts to that status change generically
-- (AFTER UPDATE on proctor_sessions, firing whenever status transitions INTO
-- 'terminated' or 'abandoned' and context looks like an exam context), so it
-- covers every path that can end a session that way: the violation-limit
-- termination AND the concurrent-session-detected abandon path
-- (_create_proctor_session marks the OLD session 'abandoned' when a second
-- one starts for the same context — a second attempt can't be started for
-- the same exam per the one-attempt policy, but a second browser tab
-- resuming the SAME attempt and calling start_exam_attempt again would
-- reuse the existing in_progress attempt without minting a new session, so
-- this mainly guards defensively against any future path that abandons a
-- session; it is intentionally not narrowed to only the violation_limit
-- case).
--
-- Recursion guard: this trigger only ever UPDATEs exam_attempts, never
-- proctor_sessions, so it cannot re-fire itself. It runs in whatever
-- security context the triggering statement runs in (log_proctor_events is
-- SECURITY DEFINER, so the UPDATE on proctor_sessions inside it executes as
-- the function owner; a trigger function executes with the privileges of
-- the object owner too when marked SECURITY DEFINER itself) — declared
-- SECURITY DEFINER + `set search_path = ''` here for the same reason every
-- other privileged writer in this codebase is, so it can update
-- exam_attempts regardless of who/what context ultimately caused the
-- proctor_sessions status change.
create or replace function public.sync_exam_attempt_on_proctor_termination()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt record;
  v_exam record;
  v_paper jsonb;
  v_section jsonb;
  v_question jsonb;
  v_response jsonb;
  v_slot_score numeric;
  v_auto_score numeric := 0;
  v_max_score numeric := 0;
  v_needs_manual boolean := false;
begin
  -- Only react to a genuine transition INTO a terminal status, only for
  -- sessions scoped to an exam attempt (context = 'exam:<uuid>'), and only
  -- when that transition actually just happened (old status was different).
  if new.status not in ('terminated', 'abandoned') or old.status = new.status then
    return new;
  end if;

  if new.context !~ '^exam:' then
    return new;
  end if;

  select * into v_attempt
  from public.exam_attempts
  where proctor_session_id = new.id
    and status = 'in_progress'
  for update;

  -- No matching in_progress attempt (already submitted by the student in the
  -- ordinary flow, or this session was never actually linked) — nothing to
  -- do. This is the common, unremarkable case for a session ended via the
  -- normal "I have submitted" flow's end_proctor_session call, which does
  -- NOT go through this terminated/abandoned branch anyway (end_proctor_session
  -- sets status='ended', not terminated/abandoned).
  if v_attempt.id is null then
    return new;
  end if;

  select * into v_exam from public.exams where id = v_attempt.exam_id;

  select frozen_paper into v_paper
  from public.exam_attempt_papers
  where exam_attempt_papers.attempt_id = v_attempt.id;

  -- Grade whatever objective answers exist so far, exactly like
  -- submit_exam_attempt does — essays contribute 0 and set
  -- needs_manual_grading, same as a normal submission with unanswered/essay
  -- slots. A session can terminate before any paper row exists only in a
  -- pathological race (session created, attempt insert failed) — guard with
  -- a null check so the trigger never raises and blocks the underlying
  -- proctor_sessions update.
  if v_paper is not null then
    for v_section in select * from jsonb_array_elements(v_paper -> 'sections')
    loop
      for v_question in select * from jsonb_array_elements(v_section -> 'questions')
      loop
        v_max_score := v_max_score + coalesce(nullif((v_question -> 'body' ->> 'marks'), '')::numeric, 0);

        select ea.response into v_response
        from public.exam_answers ea
        where ea.attempt_id = v_attempt.id
          and ea.question_ref = (v_question ->> 'question_ref');

        if (v_question ->> 'type') = 'essay' then
          v_needs_manual := true;
        else
          v_slot_score := public.grade_objective_slot(v_question ->> 'type', v_question -> 'body', v_response);
          v_auto_score := v_auto_score + coalesce(v_slot_score, 0);
        end if;
      end loop;
    end loop;
  end if;

  update public.exam_attempts
  set status = 'terminated',
      submitted_at = now(),
      auto_score = v_auto_score,
      max_score = v_max_score,
      needs_manual_grading = v_needs_manual
  where id = v_attempt.id;

  perform public.log_audit(
    'proctor_termination_closed_attempt', 'exam_attempt', v_attempt.id::text,
    jsonb_build_object(
      'proctor_session_id', new.id,
      'session_status', new.status,
      'auto_score', v_auto_score,
      'max_score', v_max_score,
      'needs_manual_grading', v_needs_manual
    )
  );

  return new;
end;
$$;

comment on function public.sync_exam_attempt_on_proctor_termination() is
  'Phase 3d-ii TAMPER-PROOF termination tie: fires on proctor_sessions status transitioning into terminated/abandoned for an exam-scoped session (context ~ ''^exam:''). Closes the linked in_progress exam_attempts row (status=terminated, submitted_at=now()), auto-grades every objective slot answered so far (reusing grade_objective_slot, the same path submit_exam_attempt uses), and sets needs_manual_grading for any essay slot — all server-side, no client action required. No-ops if no matching in_progress attempt is found (e.g. the student had already submitted normally). Guards against recursion by never touching proctor_sessions itself.';

create trigger proctor_sessions_sync_exam_attempt
  after update on public.proctor_sessions
  for each row
  execute function public.sync_exam_attempt_on_proctor_termination();

comment on trigger proctor_sessions_sync_exam_attempt on public.proctor_sessions is
  'Phase 3d-ii: ties proctor session termination to the linked exam_attempts row server-side — see sync_exam_attempt_on_proctor_termination(). This is what makes hitting the violation limit actually END the exam for the student, tamper-proof (log_proctor_events, not the client, flips proctor_sessions.status).';

-- 5. exam_answers gains per-slot manual grading columns -----------------

alter table public.exam_answers
  add column marks_awarded numeric,
  add column feedback text;

comment on column public.exam_answers.marks_awarded is
  'Phase 3d-ii: manual grade for an essay slot (null until graded), set only via grade_essay_slot (owner/lecturer-or-higher only), clamped to [0, slot marks]. Null for every non-essay slot — those are scored entirely by grade_objective_slot at submit time and never touch this column.';
comment on column public.exam_answers.feedback is
  'Phase 3d-ii: optional lecturer feedback text for a manually-graded essay slot, set alongside marks_awarded by grade_essay_slot. Surfaced to the student only through the same results-release gate as everything else (get_attempt_result).';

-- 6. grade_essay_slot — manual essay grading, owner/lecturer-only -----------

create or replace function public.grade_essay_slot(
  attempt_id uuid,
  question_ref text,
  marks_awarded numeric,
  feedback text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_exam_id uuid;
  v_status text;
  v_paper jsonb;
  v_slot jsonb;
  v_slot_type text;
  v_slot_marks numeric;
  v_clamped numeric;
  v_all_essays_graded boolean;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select exam_id, status into v_exam_id, v_status
  from public.exam_attempts
  where id = grade_essay_slot.attempt_id;

  if v_exam_id is null then
    raise exception 'Attempt % not found', attempt_id;
  end if;

  if not public.can_manage_exam(v_exam_id) then
    raise exception 'Only the exam owner or a lecturer-or-higher may grade this attempt';
  end if;

  if v_status not in ('submitted', 'auto_submitted', 'terminated', 'graded') then
    raise exception 'Attempt is not yet submitted; nothing to grade';
  end if;

  -- Re-derive the slot's type + marks from the frozen paper (never trust a
  -- client-supplied max — grade_essay_slot is reachable only by staff, but
  -- the clamp must still be against the REAL marks value, not whatever the
  -- caller believes it to be).
  select frozen_paper into v_paper
  from public.exam_attempt_papers
  where exam_attempt_papers.attempt_id = grade_essay_slot.attempt_id;

  if v_paper is null then
    raise exception 'No paper found for this attempt';
  end if;

  select q into v_slot
  from jsonb_array_elements(v_paper -> 'sections') sec,
       jsonb_array_elements(sec -> 'questions') q
  where (q ->> 'question_ref') = grade_essay_slot.question_ref
  limit 1;

  if v_slot is null then
    raise exception 'question_ref % does not belong to this attempt''s paper', question_ref;
  end if;

  v_slot_type := v_slot ->> 'type';
  if v_slot_type <> 'essay' then
    raise exception 'question_ref % is not an essay slot (type=%)', question_ref, v_slot_type;
  end if;

  v_slot_marks := coalesce(nullif((v_slot -> 'body' ->> 'marks'), '')::numeric, 0);

  if grade_essay_slot.marks_awarded is null then
    raise exception 'marks_awarded is required';
  end if;

  -- Clamp to [0, slot marks] rather than rejecting an out-of-range value —
  -- a lecturer fat-fingering 15 on a 10-mark question should get the
  -- sensible ceiling, not a cryptic error mid-grading session.
  v_clamped := greatest(0, least(grade_essay_slot.marks_awarded, v_slot_marks));

  insert into public.exam_answers (attempt_id, question_version_id, question_ref, marks_awarded, feedback)
  select
    grade_essay_slot.attempt_id,
    (v_slot ->> 'version_id')::uuid,
    grade_essay_slot.question_ref,
    v_clamped,
    grade_essay_slot.feedback
  on conflict on constraint exam_answers_attempt_id_question_ref_key
  do update set
    marks_awarded = excluded.marks_awarded,
    feedback = excluded.feedback;

  perform public.log_audit(
    'grade_essay_slot', 'exam_attempt', grade_essay_slot.attempt_id::text,
    jsonb_build_object('question_ref', question_ref, 'marks_awarded', v_clamped)
  );

  -- Auto-finalize once every essay slot in the paper has been graded (has a
  -- non-null marks_awarded) — the lecturer doesn't need a separate "I'm
  -- done" click for the common case of grading every essay in one sitting;
  -- finalize_attempt_grade below is still independently callable (idempotent)
  -- for the case where a lecturer wants to finalize with some essays left
  -- ungraded (defaulting the ungraded ones to 0), e.g. a no-show essay.
  select not exists (
    select 1
    from jsonb_array_elements(v_paper -> 'sections') sec,
         jsonb_array_elements(sec -> 'questions') q
    where (q ->> 'type') = 'essay'
      and not exists (
        select 1 from public.exam_answers ea
        where ea.attempt_id = grade_essay_slot.attempt_id
          and ea.question_ref = (q ->> 'question_ref')
          and ea.marks_awarded is not null
      )
  ) into v_all_essays_graded;

  if v_all_essays_graded then
    perform public.finalize_attempt_grade(grade_essay_slot.attempt_id);
  end if;
end;
$$;

comment on function public.grade_essay_slot(uuid, text, numeric, text) is
  'Phase 3d-ii manual essay grading. Owner/lecturer-or-higher only (can_manage_exam, re-derived server-side — never trusts a client claim of authority), only for essay-type slots of a submitted/auto_submitted/terminated/graded attempt. Re-derives the slot''s max marks from the frozen paper (never a client-supplied max) and clamps marks_awarded to [0, slot marks]. Upserts exam_answers.marks_awarded/feedback for that slot. When every essay slot in the paper now has a grade, automatically calls finalize_attempt_grade — a lecturer grading every essay in one pass never needs a separate finalize click.';

grant execute on function public.grade_essay_slot(uuid, text, numeric, text) to authenticated;

-- 7. finalize_attempt_grade — recompute total, set status='graded' ----------

create or replace function public.finalize_attempt_grade(attempt_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_exam_id uuid;
  v_status text;
  v_auto_score numeric;
  v_manual_total numeric;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select exam_id, status, auto_score into v_exam_id, v_status, v_auto_score
  from public.exam_attempts
  where id = finalize_attempt_grade.attempt_id;

  if v_exam_id is null then
    raise exception 'Attempt % not found', attempt_id;
  end if;

  if not public.can_manage_exam(v_exam_id) then
    raise exception 'Only the exam owner or a lecturer-or-higher may finalize this attempt''s grade';
  end if;

  if v_status not in ('submitted', 'auto_submitted', 'terminated', 'graded') then
    raise exception 'Attempt is not yet submitted; nothing to finalize';
  end if;

  select coalesce(sum(ea.marks_awarded), 0) into v_manual_total
  from public.exam_answers ea
  where ea.attempt_id = finalize_attempt_grade.attempt_id
    and ea.marks_awarded is not null;

  update public.exam_attempts
  set auto_score = coalesce(v_auto_score, 0) + v_manual_total,
      status = 'graded',
      needs_manual_grading = false
  where id = finalize_attempt_grade.attempt_id;

  perform public.log_audit(
    'finalize_attempt_grade', 'exam_attempt', finalize_attempt_grade.attempt_id::text,
    jsonb_build_object('auto_score', coalesce(v_auto_score, 0), 'manual_total', v_manual_total)
  );
end;
$$;

comment on function public.finalize_attempt_grade(uuid) is
  'Phase 3d-ii. Recomputes exam_attempts.auto_score as (the ORIGINAL objective auto_score already stored by submit_exam_attempt/the termination trigger) + (sum of every graded exam_answers.marks_awarded), sets status=''graded'' and needs_manual_grading=false. Owner/lecturer-or-higher only. Callable directly (e.g. to finalize with some essays deliberately left ungraded, defaulting to 0 marks) or automatically from grade_essay_slot once every essay in the paper has a grade. Idempotent — calling it again just recomputes the same total from the same source data.';

grant execute on function public.finalize_attempt_grade(uuid) to authenticated;

-- 8. release_exam_results — manual release switch ---------------------------
-- results_release itself already lives on exams (20260705000011); this RPC
-- is the "manual" release action a lecturer clicks. It does not change
-- results_release's VALUE (a manual-release exam stays results_release=
-- 'manual' forever — that's the exam's declared policy) but flips a new
-- per-exam released flag that get_attempt_result checks for the manual
-- case.

alter table public.exams
  add column results_released_at timestamptz;

comment on column public.exams.results_released_at is
  'Phase 3d-ii: set by release_exam_results() when results_release=''manual'' and the lecturer clicks "Release results". NULL means not yet released. Irrelevant for results_release IN (''immediate'', ''after_close''), which gate on submit-time/closes_at instead — see get_attempt_result.';

create or replace function public.release_exam_results(exam_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_release text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if not public.can_manage_exam(release_exam_results.exam_id) then
    raise exception 'Only the exam owner or a lecturer-or-higher may release this exam''s results';
  end if;

  select results_release into v_release from public.exams where id = release_exam_results.exam_id;
  if v_release is null then
    raise exception 'Exam % not found', exam_id;
  end if;

  if v_release <> 'manual' then
    raise exception 'This exam''s results_release is ''%'' — only ''manual''-release exams use release_exam_results (immediate/after_close release automatically)', v_release;
  end if;

  update public.exams set results_released_at = now() where id = release_exam_results.exam_id;

  perform public.log_audit('release_exam_results', 'exam', release_exam_results.exam_id::text, '{}'::jsonb);
end;
$$;

comment on function public.release_exam_results(uuid) is
  'Owner/lecturer-or-higher only. For a results_release=''manual'' exam, stamps exams.results_released_at = now(), which get_attempt_result then treats as "released". Raises for any other results_release value (those release automatically, not via this button).';

grant execute on function public.release_exam_results(uuid) to authenticated;

-- 9. get_attempt_result — THE gated, answer-revealing student RPC -----------
-- The ONLY place in the entire schema a student may ever see a correct
-- answer, and only once results are actually released for that exam. Owner
-- (the attempt's own student) only — re-derived from auth.uid(), never
-- trusts a client claim.
create or replace function public.get_attempt_result(attempt_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_attempt record;
  v_exam record;
  v_released boolean;
  v_paper jsonb;
  v_section jsonb;
  v_question jsonb;
  v_response jsonb;
  v_answer_row record;
  v_body jsonb;
  v_per_question jsonb := '[]'::jsonb;
  v_slot_marks numeric;
  v_slot_score numeric;
  v_correct_field jsonb;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select * into v_attempt from public.exam_attempts where id = get_attempt_result.attempt_id;
  if v_attempt.id is null then
    raise exception 'Attempt % not found', attempt_id;
  end if;

  if v_attempt.student_id <> auth.uid() then
    raise exception 'You may only view your own result';
  end if;

  if v_attempt.status not in ('submitted', 'auto_submitted', 'terminated', 'graded') then
    return jsonb_build_object('released', false, 'reason', 'not_submitted');
  end if;

  select * into v_exam from public.exams where id = v_attempt.exam_id;

  -- Release gating, mirroring submit_exam_attempt's own gate exactly:
  --   immediate    -> always released once submitted.
  --   after_close  -> released once now() > closes_at OR the exam itself is
  --                   status='closed' (a lecturer closing early should not
  --                   need to also wait for closes_at to pass).
  --   manual       -> released only once results_released_at is set.
  v_released := case coalesce(v_exam.results_release, 'after_close')
    when 'immediate' then true
    when 'after_close' then (
      v_exam.status = 'closed'
      or (v_exam.closes_at is not null and now() > v_exam.closes_at)
    )
    when 'manual' then v_exam.results_released_at is not null
    else false
  end;

  if not v_released then
    return jsonb_build_object(
      'released', false,
      'reason', 'not_yet_released',
      'results_release', v_exam.results_release,
      'status', v_attempt.status
    );
  end if;

  select frozen_paper into v_paper
  from public.exam_attempt_papers
  where exam_attempt_papers.attempt_id = get_attempt_result.attempt_id;

  if v_paper is not null then
    for v_section in select * from jsonb_array_elements(v_paper -> 'sections')
    loop
      for v_question in select * from jsonb_array_elements(v_section -> 'questions')
      loop
        v_body := v_question -> 'body';
        v_slot_marks := coalesce(nullif((v_body ->> 'marks'), '')::numeric, 0);

        select response, marks_awarded, feedback into v_answer_row
        from public.exam_answers ea
        where ea.attempt_id = get_attempt_result.attempt_id
          and ea.question_ref = (v_question ->> 'question_ref');

        v_response := v_answer_row.response;

        if (v_question ->> 'type') = 'essay' then
          v_per_question := v_per_question || jsonb_build_array(
            jsonb_build_object(
              'question_ref', v_question ->> 'question_ref',
              'prompt', v_question ->> 'prompt',
              'type', 'essay',
              'response', v_response,
              'marks_awarded', v_answer_row.marks_awarded,
              'max', v_slot_marks,
              'feedback', v_answer_row.feedback,
              'needs_manual_grading', v_answer_row.marks_awarded is null
            )
          );
        else
          v_slot_score := public.grade_objective_slot(v_question ->> 'type', v_body, v_response);
          -- The one and only place a correct answer is handed to a student
          -- client: gated above by v_released, and only ever reached for
          -- this attempt's OWN paper (auth.uid() check above).
          v_correct_field := case (v_question ->> 'type')
            when 'short_answer' then v_body -> 'accepted'
            else v_body -> 'correct'
          end;
          v_per_question := v_per_question || jsonb_build_array(
            jsonb_build_object(
              'question_ref', v_question ->> 'question_ref',
              'prompt', v_question ->> 'prompt',
              'type', v_question ->> 'type',
              'response', v_response,
              'correct', v_correct_field,
              -- Bare {id,text} pairs only (same belt-and-braces sanitization
              -- as get_attempt_questions) so the client can render "Accra"
              -- instead of a raw option id for mcq_single/mcq_multi — the
              -- release gate above already permits this attempt's own
              -- correct answer, so exposing option text alongside it adds
              -- no new disclosure.
              'options', (
                select coalesce(jsonb_agg(jsonb_build_object('id', opt ->> 'id', 'text', opt ->> 'text')), 'null'::jsonb)
                from jsonb_array_elements(v_body -> 'options') opt
              ),
              'score', v_slot_score,
              'max', v_slot_marks
            )
          );
        end if;
      end loop;
    end loop;
  end if;

  return jsonb_build_object(
    'released', true,
    'status', v_attempt.status,
    'auto_score', v_attempt.auto_score,
    'max_score', v_attempt.max_score,
    'needs_manual_grading', v_attempt.needs_manual_grading,
    'per_question', v_per_question
  );
end;
$$;

comment on function public.get_attempt_result(uuid) is
  'Phase 3d-ii: THE single answer-revealing student-facing RPC. Owner-only (auth.uid() must be the attempt''s student_id — NEVER returns another student''s result). Returns {released:false, reason:...} until the exam''s results_release condition is actually met (immediate: always once submitted; after_close: now()>closes_at or exam status=closed; manual: results_released_at is set) — before that, no score, no per-question data, nothing answer-adjacent leaves this function. Once released, returns the total plus a per-question breakdown: the student''s own response, correct/accepted answer, marks earned/available for objective types, and marks_awarded/feedback/needs_manual_grading for essay slots. This is the ONLY function in the schema permitted to disclose a correct answer to the student it belongs to.';

grant execute on function public.get_attempt_result(uuid) to authenticated;

-- 9.5 get_attempt_for_grading — lecturer-facing attempt content for grading -
-- The manual-grading UI needs to show a lecturer every essay's prompt +
-- rubric + the student's own response, REGARDLESS of results_release (a
-- lecturer must be able to grade an after_close/manual exam's essays before
-- results are released — that is the whole point of grading before
-- release). This is distinct from get_attempt_result (student-only,
-- release-gated) and from exam_results (summary only, no question content)
-- — owner/lecturer-or-higher only, never student-reachable.
create or replace function public.get_attempt_for_grading(attempt_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_exam_id uuid;
  v_status text;
  v_paper jsonb;
  v_section jsonb;
  v_question jsonb;
  v_answer_row record;
  v_per_question jsonb := '[]'::jsonb;
  v_slot_marks numeric;
  v_slot_score numeric;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select exam_id, status into v_exam_id, v_status
  from public.exam_attempts
  where id = get_attempt_for_grading.attempt_id;

  if v_exam_id is null then
    raise exception 'Attempt % not found', attempt_id;
  end if;

  if not public.can_manage_exam(v_exam_id) then
    raise exception 'Only the exam owner or a lecturer-or-higher may view this attempt';
  end if;

  select frozen_paper into v_paper
  from public.exam_attempt_papers
  where exam_attempt_papers.attempt_id = get_attempt_for_grading.attempt_id;

  if v_paper is not null then
    for v_section in select * from jsonb_array_elements(v_paper -> 'sections')
    loop
      for v_question in select * from jsonb_array_elements(v_section -> 'questions')
      loop
        v_slot_marks := coalesce(nullif((v_question -> 'body' ->> 'marks'), '')::numeric, 0);

        select response, marks_awarded, feedback into v_answer_row
        from public.exam_answers ea
        where ea.attempt_id = get_attempt_for_grading.attempt_id
          and ea.question_ref = (v_question ->> 'question_ref');

        if (v_question ->> 'type') = 'essay' then
          v_per_question := v_per_question || jsonb_build_array(
            jsonb_build_object(
              'question_ref', v_question ->> 'question_ref',
              'prompt', v_question ->> 'prompt',
              'type', 'essay',
              'rubric', v_question -> 'body' -> 'rubric',
              'response', v_answer_row.response,
              'marks_awarded', v_answer_row.marks_awarded,
              'max', v_slot_marks,
              'feedback', v_answer_row.feedback
            )
          );
        else
          v_slot_score := public.grade_objective_slot(v_question ->> 'type', v_question -> 'body', v_answer_row.response);
          v_per_question := v_per_question || jsonb_build_array(
            jsonb_build_object(
              'question_ref', v_question ->> 'question_ref',
              'prompt', v_question ->> 'prompt',
              'type', v_question ->> 'type',
              'response', v_answer_row.response,
              'score', v_slot_score,
              'max', v_slot_marks
            )
          );
        end if;
      end loop;
    end loop;
  end if;

  return jsonb_build_object(
    'attempt_id', get_attempt_for_grading.attempt_id,
    'status', v_status,
    'per_question', v_per_question
  );
end;
$$;

comment on function public.get_attempt_for_grading(uuid) is
  'Phase 3d-ii lecturer-facing grading detail: owner/lecturer-or-higher only (can_manage_exam), NEVER student-reachable, and NOT release-gated (a lecturer must be able to grade before releasing). Returns every slot''s prompt + the student''s response, plus (for essays) the rubric + current marks_awarded/feedback, and (for objective types) the auto-computed score/max for lecturer reference. Distinct from get_attempt_result (student-only, release-gated, no rubric) and exam_results (summary only, no question content).';

grant execute on function public.get_attempt_for_grading(uuid) to authenticated;

-- 10. exam_results — lecturer results + integrity summary RPC ---------------

create or replace function public.exam_results(exam_id uuid)
returns table (
  attempt_id uuid,
  student_id uuid,
  full_name text,
  student_number text,
  status text,
  auto_score numeric,
  max_score numeric,
  needs_manual_grading boolean,
  started_at timestamptz,
  submitted_at timestamptz,
  proctor_session_id uuid,
  violation_count smallint,
  violation_limit smallint,
  session_status text,
  has_report boolean
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if not public.can_manage_exam(exam_results.exam_id) then
    raise exception 'Only the exam owner or a lecturer-or-higher may view its results';
  end if;

  return query
  select
    ea.id as attempt_id,
    ea.student_id,
    p.full_name,
    p.student_number,
    ea.status,
    ea.auto_score,
    ea.max_score,
    ea.needs_manual_grading,
    ea.started_at,
    ea.submitted_at,
    ea.proctor_session_id,
    ps.violation_count,
    ps.violation_limit,
    ps.status as session_status,
    exists (select 1 from public.proctor_reports r where r.session_id = ea.proctor_session_id) as has_report
  from public.exam_attempts ea
  join public.profiles p on p.id = ea.student_id
  left join public.proctor_sessions ps on ps.id = ea.proctor_session_id
  where ea.exam_id = exam_results.exam_id
  order by ea.started_at desc;
end;
$$;

comment on function public.exam_results(uuid) is
  'Phase 3d-ii lecturer results view: one row per attempt at this exam with the student''s identity, grading state, and (for tier>=2 attempts) the linked proctor session''s integrity summary — violation_count/violation_limit/session_status/has_report. NOT the full Phase 4 review workspace (no video timeline, no per-flag verdicts) — just enough for a lecturer to see who needs grading and whose attempt carries integrity concerns worth opening in Studio. Owner/lecturer-or-higher only (can_manage_exam).';

grant execute on function public.exam_results(uuid) to authenticated;
