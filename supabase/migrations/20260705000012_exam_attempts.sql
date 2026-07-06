-- Phase 3d-i: the SECURE EXAM-TAKING SPINE — attempts, sanitized delivery,
-- autosave/resume, server-authoritative timer, objective auto-grading.
--
-- Scope (PLAN.md Phase 3 decomposition, "Phase 3d" bullet + integrity tiers
-- T1..T4): this migration delivers a T1-complete exam room (server-side
-- anti-cheat only — no webcam/proctor-core attachment, that is 3d-ii) plus
-- the plumbing every higher tier will reuse: attempt lifecycle, the frozen
-- per-attempt paper, one-question-at-a-time sanitized delivery, autosave,
-- resume-on-disconnect, a server-authoritative deadline (+ accommodations
-- extra-time), submission, and auto-grading of objective question types.
-- Manual essay grading, results-release-to-student UI, and proctoring
-- attachment are Phase 3d-ii.
--
-- THE SINGLE MOST IMPORTANT PROPERTY OF THIS MIGRATION: correct answers
-- must never reach the client. draw_exam_for_attempt (20260705000011) is
-- already locked down (EXECUTE revoked from public/anon/authenticated) and
-- is called ONLY from start_exam_attempt below, itself security definer.
-- The result — the "frozen paper", body verbatim INCLUDING correct/
-- accepted/tolerance/rubric fields — is stored in a companion table,
-- exam_attempt_papers, that carries **NO SELECT POLICY AT ALL** for any
-- client role (not even the owning student): RLS is force-enabled with
-- zero policies, so a direct `.from("exam_attempt_papers").select()` from
-- any authenticated (or anon) role returns zero rows, full stop. This is
-- choice (a) documented in the task brief's RLS section: rather than try to
-- hide a single jsonb COLUMN from a student who can otherwise SELECT their
-- own exam_attempts row (Postgres RLS has no column-level SELECT), the
-- entire answer-bearing payload lives in a separate table students cannot
-- query under any policy. The ONLY way to read a paper's content is through
-- get_attempt_questions() (returns the SANITIZED shape, correct-answer
-- fields stripped server-side in SQL, never trust-the-caller) or
-- submit_exam_attempt() (reads it internally to grade, never returns the
-- raw body). Both are security definer and re-derive "is this my own
-- attempt" from auth.uid() before touching exam_attempt_papers.
--
-- Re-attempt policy (documented, not yet configurable): ONE attempt per
-- (exam_id, student_id), enforced by a unique partial index on
-- status='in_progress' plus start_exam_attempt's own "resume if one already
-- exists, else look for ANY prior attempt and refuse" logic. A future phase
-- can add a per-exam max_attempts column; out of scope here.
--
-- Server-side abandoned-attempt auto-submit: NOT built as a scheduler here
-- (task brief explicitly excludes standing up a cron/edge scheduler this
-- phase). Enforcement is instead lazy and still fully server-authoritative:
-- save_exam_answer refuses any write once now() > deadline_at, and
-- get_attempt_questions reports whether the attempt is expired so the
-- client can show "time's up" and call submit_exam_attempt immediately
-- (which timestamps status='auto_submitted' when called past deadline_at).
-- A genuinely abandoned attempt (student closes the tab and never returns)
-- simply stays 'in_progress' with 0 answers past its own deadline until
-- either the student returns (submits late -> auto_submitted) or a future
-- scheduled job sweeps it — documented TODO for 3d-ii/Phase 6.
--
-- Same security posture as every prior migration: RLS enabled + forced on
-- every table, has_role()/can_manage_exam() for role checks, security
-- definer RPCs with `set search_path = ''`, and the 20260705000006
-- EXECUTE-revoke lock-down pattern applied to every helper that trusts its
-- arguments (grade_objective_slot) rather than re-deriving authority.

-- 1. exam_attempts -----------------------------------------------------------

create table public.exam_attempts (
  id uuid primary key default gen_random_uuid(),
  exam_id uuid not null references public.exams (id) on delete cascade,
  student_id uuid not null references auth.users (id) on delete cascade,
  status text not null default 'in_progress' check (
    status in ('in_progress', 'submitted', 'auto_submitted', 'graded', 'terminated')
  ),
  -- The seed handed to draw_exam_for_attempt — kept here (not just inside
  -- the frozen paper) so a re-draw/audit can be requested by seed alone
  -- without opening exam_attempt_papers.
  seed text not null,
  started_at timestamptz not null default now(),
  deadline_at timestamptz not null,
  submitted_at timestamptz,
  auto_score numeric,
  max_score numeric,
  needs_manual_grading boolean not null default false,
  created_at timestamptz not null default now()
);

comment on table public.exam_attempts is
  'Phase 3d-i: one row per student attempt at an exam. Carries NO question content or answers (see exam_attempt_papers) — only lifecycle/timing/score state, so this table is safe to expose to the owning student via a normal RLS SELECT policy. Re-attempt policy: at most one attempt per (exam_id, student_id) — see exam_attempts_one_in_progress_idx (at most one in_progress) and start_exam_attempt (refuses a second attempt once ANY prior attempt exists for that pair, in_progress or not — "one attempt per student per exam" for now, documented as a KNOWN SIMPLIFICATION a future max_attempts column can relax).';
comment on column public.exam_attempts.seed is
  'The per-attempt seed passed to draw_exam_for_attempt (20260705000011) — same seed always reproduces the same frozen paper, matching that function''s determinism guarantee. Stored alongside the frozen paper (also embedded inside exam_attempt_papers.frozen_paper) for audit convenience.';
comment on column public.exam_attempts.deadline_at is
  'Server-authoritative deadline = started_at + duration_minutes (exams.duration_minutes) scaled by the student''s profiles.accommodations->>''extra_time_multiplier'' (default 1.0) at attempt-start time (DESIGN.md §3 "Timing adjustable"). NULL duration_minutes on the exam means "no time limit" — represented here as a far-future deadline (see start_exam_attempt) rather than a nullable column, so every other RPC can compare against deadline_at unconditionally without a null-check branch.';
comment on column public.exam_attempts.needs_manual_grading is
  'True when the frozen paper contains at least one essay slot (or any type submit_exam_attempt could not auto-grade). Essay grading itself is Phase 3d-ii — this flag just records that the attempt is not fully graded yet.';

create index exam_attempts_exam_id_idx on public.exam_attempts (exam_id);
create index exam_attempts_student_id_idx on public.exam_attempts (student_id);

-- At most one NON-TERMINAL (in_progress) attempt per (exam_id, student_id):
-- start_exam_attempt resumes into this row rather than creating a duplicate.
-- Terminal statuses (submitted/auto_submitted/graded/terminated) are
-- excluded from the partial index so history is never blocked by it —
-- start_exam_attempt separately refuses a brand-new attempt once ANY row
-- (terminal or not) exists for the pair, per the one-attempt policy above;
-- this index specifically prevents two concurrent in_progress rows, which
-- is the scenario that would otherwise be a race (e.g. two tabs both
-- calling start_exam_attempt at once).
create unique index exam_attempts_one_in_progress_idx
  on public.exam_attempts (exam_id, student_id)
  where status = 'in_progress';

-- 2. exam_attempt_papers — the FROZEN PAPER, answers included, NO client SELECT at all

create table public.exam_attempt_papers (
  attempt_id uuid primary key references public.exam_attempts (id) on delete cascade,
  frozen_paper jsonb not null
);

comment on table public.exam_attempt_papers is
  'Phase 3d-i: THE answer-bearing table. frozen_paper is the FULL draw_exam_for_attempt() output verbatim — every question''s body INCLUDING correct/accepted/tolerance/rubric fields. RLS is enabled + forced with ZERO policies for any client role (not even the owning student) — see this migration''s header comment for why this is choice (a) over trying to hide a single column. The only readers are security-definer functions below (get_attempt_questions strips answers before returning; submit_exam_attempt reads it internally to grade and never returns it raw) plus the service role. A direct `.from("exam_attempt_papers").select()` from ANY authenticated or anon client returns zero rows unconditionally.';

alter table public.exam_attempt_papers enable row level security;
alter table public.exam_attempt_papers force row level security;
-- Deliberately no policies at all: force row level security + zero policies
-- means every role (including the table owner querying through PostgREST,
-- i.e. authenticated/anon) gets zero rows from a direct SELECT/INSERT/
-- UPDATE/DELETE. Only a security-definer function (which runs as the
-- function owner and is NOT subject to FORCE ROW LEVEL SECURITY the way an
-- ordinary table-owner session would be — functions execute the same as
-- any other access under the owner's normal bypass-RLS privilege on tables
-- it owns) or the service role can read/write this table.

-- 3. exam_answers -------------------------------------------------------------

create table public.exam_answers (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references public.exam_attempts (id) on delete cascade,
  question_version_id uuid not null,
  -- The per-attempt SLOT id (not just question_version_id): a pool draw can
  -- legitimately place the same question_version_id in a paper only once
  -- per attempt today, but sections are independent draws and a future
  -- looser pool config could repeat a version across sections. question_ref
  -- is the frozen paper's own per-slot identity (section_id:index, minted
  -- when the paper is frozen — see start_exam_attempt), so autosave always
  -- targets an unambiguous slot regardless of how the draw is shaped.
  question_ref text not null,
  response jsonb,
  flagged boolean not null default false,
  updated_at timestamptz not null default now(),
  unique (attempt_id, question_ref)
);

comment on table public.exam_answers is
  'Phase 3d-i: one row per (attempt, question slot) — the student''s in-progress or final response, autosaved via save_exam_answer(). question_ref (not question_version_id alone) is the unique slot key — see column comment. Contains only the STUDENT''S OWN response, never the correct answer (that lives solely in exam_attempt_papers).';
comment on column public.exam_answers.question_ref is
  'The frozen paper''s per-slot identifier, minted as "<section_id>:<index-within-section>" when start_exam_attempt freezes the paper (see that function and get_attempt_questions). Stable for the lifetime of the attempt; the same slot always autosaves to the same row regardless of client-side re-renders.';
comment on column public.exam_answers.response is
  'Shape depends on the slot''s question type: mcq_single -> {"selected": optionId}; mcq_multi -> {"selected": [optionId,...]}; true_false -> {"selected": boolean}; numeric -> {"value": number}; short_answer -> {"text": string}; essay -> {"text": string}. Validated loosely by save_exam_answer (rejects non-object payloads) — full per-type shape checking happens at grading time in submit_exam_attempt, which is tolerant of a missing/malformed response (treated as unanswered, scored 0) rather than raising, since an autosave payload must never be able to crash-fail a save this close to a deadline.';

create index exam_answers_attempt_id_idx on public.exam_answers (attempt_id);

create trigger exam_answers_set_updated_at
  before update on public.exam_answers
  for each row
  execute function public.set_updated_at();

-- 4. RLS ------------------------------------------------------------------
-- Policy matrix:
--   exam_attempts:
--     SELECT  owner (student_id = auth.uid()) OR can_manage_exam(exam_id)
--             (the exam's owner/lecturer-or-higher, for Phase 3d-ii grading
--             and results tooling — read-only here, no client UPDATE policy
--             for either party).
--     No client INSERT/UPDATE/DELETE at all: every write goes through
--     start_exam_attempt / submit_exam_attempt (security definer), which
--     re-derive ownership from auth.uid() themselves.
--
--   exam_answers:
--     SELECT  owner (via the parent attempt's student_id) OR
--             can_manage_exam(the parent attempt's exam_id).
--     No client INSERT/UPDATE/DELETE: all writes go through
--     save_exam_answer (security definer, owner-only, deadline-checked).
--
--   exam_attempt_papers: NO POLICIES AT ALL (see table comment above) —
--     not even a SELECT for the owning student. This is the single
--     load-bearing security property of this migration.

alter table public.exam_attempts enable row level security;
alter table public.exam_attempts force row level security;

alter table public.exam_answers enable row level security;
alter table public.exam_answers force row level security;

create policy exam_attempts_select_owner_or_exam_manager
  on public.exam_attempts
  for select
  to authenticated
  using (
    student_id = auth.uid()
    or public.can_manage_exam(exam_id)
  );

create policy exam_answers_select_owner_or_exam_manager
  on public.exam_answers
  for select
  to authenticated
  using (
    exists (
      select 1 from public.exam_attempts a
      where a.id = exam_answers.attempt_id
        and (a.student_id = auth.uid() or public.can_manage_exam(a.exam_id))
    )
  );

-- No INSERT/UPDATE/DELETE client policies for exam_attempts/exam_answers:
-- all writes go through the RPCs below (security definer, each re-deriving
-- ownership from auth.uid() before touching a row).

-- 5. grade_objective_slot — pure grading helper, LOCKED DOWN -----------------
-- Grades ONE slot's response against its (unsanitized) body. Pure/stable,
-- no auth.uid() check of its own — it trusts whatever body/response it is
-- handed, exactly like draw_exam_for_attempt trusts its (exam_id, seed).
-- That means it is answer-ADJACENT (a crafted body+response probe could be
-- used to binary-search a correct answer if this were client-callable) even
-- though it never itself SELECTs exam_attempt_papers, so it gets the same
-- 20260705000006 EXECUTE-revoke treatment: callable only from
-- submit_exam_attempt (security definer, runs as owner, retains its own
-- grant despite the public revoke).
create or replace function public.grade_objective_slot(
  question_type text,
  body jsonb,
  response jsonb
)
returns numeric
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_marks numeric := coalesce(nullif(body->>'marks', '')::numeric, 0);
  v_correct_arr jsonb;
  v_selected_arr jsonb;
  v_correct_set text[];
  v_selected_set text[];
  v_correct_num numeric;
  v_tolerance numeric;
  v_response_num numeric;
  v_accepted jsonb;
  v_case_sensitive boolean;
  v_text text;
  v_accepted_text text;
  v_match boolean;
begin
  if response is null or jsonb_typeof(response) <> 'object' then
    return 0;
  end if;

  if question_type = 'mcq_single' then
    v_correct_arr := body -> 'correct';
    if v_correct_arr is null or jsonb_array_length(v_correct_arr) <> 1 then
      return 0;
    end if;
    if (response ->> 'selected') is null then
      return 0;
    end if;
    if (response ->> 'selected') = (v_correct_arr ->> 0) then
      return v_marks;
    end if;
    return 0;

  elsif question_type = 'mcq_multi' then
    v_correct_arr := coalesce(body -> 'correct', '[]'::jsonb);
    v_selected_arr := response -> 'selected';
    if v_selected_arr is null or jsonb_typeof(v_selected_arr) <> 'array' then
      return 0;
    end if;
    select coalesce(array_agg(value order by value), '{}') into v_correct_set
    from jsonb_array_elements_text(v_correct_arr);
    select coalesce(array_agg(value order by value), '{}') into v_selected_set
    from jsonb_array_elements_text(v_selected_arr);
    -- Exact SET match only — no partial credit for now (documented in the
    -- task brief): every correct option selected, no incorrect ones, and no
    -- duplicates smuggled in (array_agg over a set-deduplicated distinct
    -- both sides would hide duplicate-vote cheesing, so compare distinct
    -- sorted arrays explicitly).
    select coalesce(array_agg(distinct value order by value), '{}') into v_correct_set
    from unnest(v_correct_set) as value;
    select coalesce(array_agg(distinct value order by value), '{}') into v_selected_set
    from unnest(v_selected_set) as value;
    if v_correct_set = v_selected_set then
      return v_marks;
    end if;
    return 0;

  elsif question_type = 'true_false' then
    if jsonb_typeof(body -> 'correct') <> 'boolean' or jsonb_typeof(response -> 'selected') <> 'boolean' then
      return 0;
    end if;
    if (body ->> 'correct')::boolean = (response ->> 'selected')::boolean then
      return v_marks;
    end if;
    return 0;

  elsif question_type = 'numeric' then
    v_correct_num := nullif(body ->> 'correct', '')::numeric;
    v_tolerance := coalesce(nullif(body ->> 'tolerance', '')::numeric, 0);
    begin
      v_response_num := nullif(response ->> 'value', '')::numeric;
    exception when others then
      v_response_num := null;
    end;
    if v_correct_num is null or v_response_num is null then
      return 0;
    end if;
    if abs(v_response_num - v_correct_num) <= abs(v_tolerance) then
      return v_marks;
    end if;
    return 0;

  elsif question_type = 'short_answer' then
    v_accepted := coalesce(body -> 'accepted', '[]'::jsonb);
    v_case_sensitive := coalesce((body ->> 'case_sensitive')::boolean, false);
    v_text := trim(coalesce(response ->> 'text', ''));
    if v_text = '' then
      return 0;
    end if;
    v_match := false;
    for v_accepted_text in select trim(value) from jsonb_array_elements_text(v_accepted) as value
    loop
      if v_case_sensitive then
        if v_text = v_accepted_text then
          v_match := true;
        end if;
      else
        if lower(v_text) = lower(v_accepted_text) then
          v_match := true;
        end if;
      end if;
    end loop;
    if v_match then
      return v_marks;
    end if;
    return 0;

  else
    -- essay (and any unrecognized type): not objectively gradable here.
    return 0;
  end if;
end;
$$;

comment on function public.grade_objective_slot(text, jsonb, jsonb) is
  'Pure per-slot grading: mcq_single (exact option match), mcq_multi (exact set match, no partial credit), true_false, numeric (within |tolerance|), short_answer (any accepted string, case-insensitive unless body.case_sensitive), else 0 (essay is manually graded in Phase 3d-ii). Trusts its body/response arguments completely (no auth.uid() check) — ANSWER-ADJACENT (a crafted probe could binary-search a correct answer) so EXECUTE is revoked from public/anon/authenticated immediately below, exactly like the 20260705000006 pattern. Callable only from submit_exam_attempt.';

revoke execute on function public.grade_objective_slot(text, jsonb, jsonb) from public, anon, authenticated;

-- 6. start_exam_attempt — enroll+published+window+attestation gate, resume ---

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
  -- without a lock.
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

  perform public.log_audit(
    'start_exam_attempt', 'exam_attempt', v_new_id::text,
    jsonb_build_object('exam_id', start_exam_attempt.exam_id, 'claimed_index_number', v_claimed, 'multiplier', v_multiplier)
  );

  return v_new_id;
end;
$$;

comment on function public.start_exam_attempt(uuid, text, boolean) is
  'Entry point for taking an exam. Validates: attested=true (identity gate, same spirit as start_proctor_session), exam is published and now() is within [opens_at, closes_at], and the caller is a class_members row for exam.class_id. Resumes an existing in_progress attempt if one exists (idempotent — never duplicates); otherwise enforces the one-attempt-per-exam policy, calls the locked-down draw_exam_for_attempt (reachable here because this function is itself security definer and runs as the owner, which retains its EXECUTE grant), mints a stable question_ref per slot, computes deadline_at from exams.duration_minutes scaled by the caller''s profiles.accommodations->>extra_time_multiplier (null duration = a far-future deadline, i.e. no time limit), and stores the frozen paper in exam_attempt_papers (never exam_attempts itself). Returns the attempt id. Audit-logged.';

grant execute on function public.start_exam_attempt(uuid, text, boolean) to authenticated;

-- 7. get_attempt_questions — SANITIZED delivery, answers stripped -----------

create or replace function public.get_attempt_questions(attempt_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_attempt record;
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

  if v_attempt.status not in ('in_progress', 'submitted', 'auto_submitted', 'graded') then
    raise exception 'This attempt is not accessible';
  end if;

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
    'answers', v_answers
  );
end;
$$;

comment on function public.get_attempt_questions(uuid) is
  'THE sanitized delivery RPC — owner-only, attempt must be in a readable status. Strips body.correct/accepted/case_sensitive/tolerance/rubric from EVERY question slot server-side (never trust-the-client filtering) before returning, and rebuilds options as bare {id,text} pairs as a second belt-and-braces layer. Also returns the student''s saved responses/flags (from exam_answers) plus deadline_at + server now() so the client can render resume state and sync a server-authoritative countdown without trusting its own clock. NEVER returns exam_attempt_papers'' raw frozen_paper.';

grant execute on function public.get_attempt_questions(uuid) to authenticated;

-- 8. save_exam_answer — autosave, owner-only, deadline-enforced --------------

create or replace function public.save_exam_answer(
  attempt_id uuid,
  question_ref text,
  response jsonb default null,
  flagged boolean default false
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt record;
  v_slot_exists boolean;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select * into v_attempt from public.exam_attempts where id = save_exam_answer.attempt_id;
  if v_attempt.id is null then
    raise exception 'Attempt % not found', save_exam_answer.attempt_id;
  end if;

  if v_attempt.student_id <> auth.uid() then
    raise exception 'You may only save answers on your own attempt';
  end if;

  if v_attempt.status <> 'in_progress' then
    raise exception 'This attempt is no longer in progress';
  end if;

  if now() > v_attempt.deadline_at then
    raise exception 'The deadline for this attempt has passed; answers can no longer be saved';
  end if;

  select exists (
    select 1
    from public.exam_attempt_papers p,
         jsonb_array_elements(p.frozen_paper -> 'sections') sec,
         jsonb_array_elements(sec -> 'questions') q
    where p.attempt_id = save_exam_answer.attempt_id
      and (q ->> 'question_ref') = save_exam_answer.question_ref
  ) into v_slot_exists;

  if not v_slot_exists then
    raise exception 'question_ref % does not belong to this attempt''s paper', save_exam_answer.question_ref;
  end if;

  -- ON CONFLICT ON CONSTRAINT (not a bare column list): the conflict target
  -- list cannot be schema/table-qualified at all
  -- (`on conflict (exam_answers.attempt_id, ...)` is a syntax error), so as
  -- long as this function's parameters are named attempt_id/question_ref,
  -- any bare column-list conflict target is inherently ambiguous against
  -- them — the exact 20260705000009 class of bug. Fixed the same way:
  -- reference the unique constraint by name instead.
  insert into public.exam_answers (attempt_id, question_version_id, question_ref, response, flagged)
  select
    save_exam_answer.attempt_id,
    (q ->> 'version_id')::uuid,
    save_exam_answer.question_ref,
    save_exam_answer.response,
    coalesce(save_exam_answer.flagged, false)
  from public.exam_attempt_papers p,
       jsonb_array_elements(p.frozen_paper -> 'sections') sec,
       jsonb_array_elements(sec -> 'questions') q
  where p.attempt_id = save_exam_answer.attempt_id
    and (q ->> 'question_ref') = save_exam_answer.question_ref
  on conflict on constraint exam_answers_attempt_id_question_ref_key
  do update set
    response = excluded.response,
    flagged = excluded.flagged;
end;
$$;

comment on function public.save_exam_answer(uuid, text, jsonb, boolean) is
  'Autosave endpoint, called often (debounced from the client). Owner-only, attempt must be in_progress, and — the server-authoritative deadline enforcement — REJECTS any save once now() > deadline_at regardless of client-claimed state. Upserts exam_answers keyed on (attempt_id, question_ref). Validates question_ref actually belongs to this attempt''s frozen paper (cheap existence check via exam_attempt_papers, never exposing its content) before writing.';

grant execute on function public.save_exam_answer(uuid, text, jsonb, boolean) to authenticated;

-- 9. submit_exam_attempt — auto-grade objective slots, gate by results_release

create or replace function public.submit_exam_attempt(attempt_id uuid)
returns jsonb
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
  v_new_status text;
  v_per_question jsonb := '[]'::jsonb;
  v_reveal boolean;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select * into v_attempt from public.exam_attempts where id = submit_exam_attempt.attempt_id;
  if v_attempt.id is null then
    raise exception 'Attempt % not found', submit_exam_attempt.attempt_id;
  end if;

  if v_attempt.student_id <> auth.uid() then
    raise exception 'You may only submit your own attempt';
  end if;

  if v_attempt.status <> 'in_progress' then
    raise exception 'This attempt has already been submitted';
  end if;

  select * into v_exam from public.exams where id = v_attempt.exam_id;

  select frozen_paper into v_paper
  from public.exam_attempt_papers
  where exam_attempt_papers.attempt_id = submit_exam_attempt.attempt_id;

  -- Late submission is accepted (a student who was mid-answer when the
  -- clock hit zero must still be able to hit Submit) but is recorded as
  -- auto_submitted rather than submitted, so lecturer tooling can tell the
  -- two apart. This is the "lazy" half of deadline enforcement documented
  -- at the top of this migration: no scheduler forces this, the student's
  -- own submit (or their next get_attempt_questions-driven client-side
  -- auto-submit once it observes now() > deadline_at) does.
  v_new_status := case when now() > v_attempt.deadline_at then 'auto_submitted' else 'submitted' end;

  for v_section in select * from jsonb_array_elements(v_paper -> 'sections')
  loop
    for v_question in select * from jsonb_array_elements(v_section -> 'questions')
    loop
      v_max_score := v_max_score + coalesce(nullif((v_question -> 'body' ->> 'marks'), '')::numeric, 0);

      select ea.response into v_response
      from public.exam_answers ea
      where ea.attempt_id = submit_exam_attempt.attempt_id
        and ea.question_ref = (v_question ->> 'question_ref');

      if (v_question ->> 'type') = 'essay' then
        v_needs_manual := true;
        v_per_question := v_per_question || jsonb_build_array(
          jsonb_build_object('question_ref', v_question ->> 'question_ref', 'needs_manual_grading', true)
        );
      else
        v_slot_score := public.grade_objective_slot(v_question ->> 'type', v_question -> 'body', v_response);
        v_auto_score := v_auto_score + coalesce(v_slot_score, 0);
        v_per_question := v_per_question || jsonb_build_array(
          jsonb_build_object(
            'question_ref', v_question ->> 'question_ref',
            'score', v_slot_score,
            'max', coalesce(nullif((v_question -> 'body' ->> 'marks'), '')::numeric, 0)
          )
        );
      end if;
    end loop;
  end loop;

  update public.exam_attempts
  set status = v_new_status,
      submitted_at = now(),
      auto_score = v_auto_score,
      max_score = v_max_score,
      needs_manual_grading = v_needs_manual
  where id = submit_exam_attempt.attempt_id;

  perform public.log_audit(
    'submit_exam_attempt', 'exam_attempt', submit_exam_attempt.attempt_id::text,
    jsonb_build_object('status', v_new_status, 'auto_score', v_auto_score, 'max_score', v_max_score)
  );

  -- results_release gating: per-question correctness is only handed back
  -- immediately when the exam is configured for 'immediate' release.
  -- 'after_close'/'manual' get totals + ack only, never the per-question
  -- breakdown, at submit time — the whole point of results_release is that
  -- a student must not learn correctness before the lecturer intends it,
  -- and returning it here would defeat that regardless of what any later
  -- results-view page chooses to show (Phase 3d-ii).
  v_reveal := coalesce(v_exam.results_release, 'after_close') = 'immediate';

  return jsonb_build_object(
    'attempt_id', submit_exam_attempt.attempt_id,
    'status', v_new_status,
    'auto_score', v_auto_score,
    'max_score', v_max_score,
    'needs_manual_grading', v_needs_manual,
    'results_released', v_reveal,
    'per_question', case when v_reveal then v_per_question else null end
  );
end;
$$;

comment on function public.submit_exam_attempt(uuid) is
  'Owner-only. Allowed while in_progress even slightly past deadline_at (recorded as auto_submitted rather than submitted — see this function''s body comment on the lazy deadline model). Auto-grades every non-essay slot via grade_objective_slot against the frozen paper (never against a client-supplied answer key); essay slots set needs_manual_grading=true and contribute 0 (graded in Phase 3d-ii). Stores auto_score/max_score/needs_manual_grading/status/submitted_at. Returns per-question correctness ONLY when exams.results_release=''immediate''; ''after_close''/''manual'' return totals + ack only, never the per-question breakdown, honoring the lecturer''s release choice at the earliest possible point rather than relying on a later view to re-hide it.';

grant execute on function public.submit_exam_attempt(uuid) to authenticated;
