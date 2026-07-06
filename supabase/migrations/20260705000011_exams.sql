-- Phase 3c: the EXAM BUILDER — exams, sections, fixed/pool question sources,
-- per-attempt deterministic seeded draw, and validation-gated publish.
--
-- Scope (PLAN.md Phase 3 decomposition): this migration defines exams that
-- attach to a class (3a) and draw questions from banks (3b), plus a
-- server-side draw function Phase 3d will call at attempt-start. It does
-- NOT build exam_attempts/answers/grading — that is Phase 3d. Nothing here
-- lets a student start an attempt or see a question's content or correct
-- answer; the only student-facing surface is a listing SELECT on `exams`
-- itself (title/schedule/duration for "Upcoming exams"), gated exactly like
-- forms_exams' published-and-open policy plus a class_members check.
--
-- Security posture, same as every prior migration: RLS enabled + forced on
-- every table, has_role()/is_admin_or_higher() for role checks (super_admin
-- universal), security-definer RPCs with `set search_path = ''`. Building
-- RPCs (create_exam, add_exam_section, add_section_source, ...) re-derive
-- authority from auth.uid() + ownership/has_role() themselves, exactly like
-- 3a/3b's create_class/create_question — no EXECUTE lock-down needed there.
--
-- The ONE function that genuinely needs the 20260705000006 lock-down
-- pattern is draw_exam_for_attempt: it returns the frozen question content
-- INCLUDING correct answers, which must never reach a student directly.
-- EXECUTE is revoked from public/anon/authenticated immediately after
-- creation — see section 8 below. It stays callable by: (a) the service
-- role (Phase 3d's future attempt-creation code, likely a server action
-- using the admin client), and (b) preview_exam_draw, a SECURITY DEFINER
-- wrapper that re-derives "is this caller the owner or a lecturer" before
-- calling it, exactly the way _create_proctor_session is only reachable
-- through start_proctor_session/start_forms_exam_session. A definer
-- function's OWN execute grant is what is checked when it calls another
-- function, not the calling role's — so preview_exam_draw (owned by
-- postgres, which retains its grant) can still call draw_exam_for_attempt
-- after the revoke, exactly like the forms_exams precedent.

-- 1. exams ------------------------------------------------------------------

create table public.exams (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  -- The cohort that may take this exam. NULL = not takeable by students yet
  -- (still being built, or intentionally never opened to a class). ON
  -- DELETE SET NULL rather than CASCADE: deleting a class should not delete
  -- exams built against it, just stop making them visible to that roster.
  class_id uuid references public.classes (id) on delete set null,
  title text not null,
  description text,
  status text not null default 'draft' check (status in ('draft', 'published', 'closed')),
  opens_at timestamptz,
  closes_at timestamptz,
  duration_minutes int check (duration_minutes is null or duration_minutes > 0),
  integrity_tier smallint not null default 2 check (integrity_tier between 1 and 4),
  violation_policy jsonb not null default public.default_violation_policy(),
  shuffle_questions boolean not null default true,
  shuffle_options boolean not null default true,
  results_release text not null default 'after_close' check (
    results_release in ('immediate', 'after_close', 'manual')
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.exams is
  'Phase 3c: the exam entity. class_id is the cohort that may take it (null = not yet takeable by any student) — mirrors forms_exams'' status(draft/published/closed) + scheduling window model, with a class_members check layered on top for the student SELECT policy. The actual question content lives in exam_sections/exam_section_sources (this migration) and questions/question_versions (3b, 20260705000010) — never duplicated here.';
comment on column public.exams.class_id is
  'The class (3a) whose members may take this exam once published and in-window. Null means no cohort is assigned yet, so the student SELECT policy (which requires class_members membership) can never match — the exam simply is not listed to anyone.';
comment on column public.exams.violation_policy is
  'Same shape as proctor_sessions.violation_policy / forms_exams.violation_policy (event_type -> {severity, counts}), reusing ViolationPolicyEditor in the builder UI. Snapshotted onto each attempt''s proctor session at attempt-start time in Phase 3d, exactly like forms_exams -> start_forms_exam_session.';
comment on column public.exams.shuffle_questions is
  'Phase 3c anti-cheat: when true, section and question order within each section is randomized per attempt (deterministic given the attempt''s seed — see draw_exam_for_attempt). Sections stay grouped; only order within/of them shuffles.';
comment on column public.exams.shuffle_options is
  'Phase 3c anti-cheat: when true, MCQ/true-false option order is randomized per attempt (deterministic given the seed).';
comment on column public.exams.results_release is
  'immediate: student sees their result as soon as auto-grading finishes (Phase 3d). after_close: only once the exam''s closes_at has passed. manual: only when the lecturer explicitly releases them (Phase 3d UI). Stored here so the builder configures it even though release logic is a Phase 3d concern.';

create index exams_owner_id_idx on public.exams (owner_id);
create index exams_class_id_idx on public.exams (class_id);
create index exams_status_idx on public.exams (status);

create trigger exams_set_updated_at
  before update on public.exams
  for each row
  execute function public.set_updated_at();

-- 2. exam_sections ------------------------------------------------------------

create table public.exam_sections (
  id uuid primary key default gen_random_uuid(),
  exam_id uuid not null references public.exams (id) on delete cascade,
  title text not null,
  description text,
  ordinal int not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (exam_id, ordinal)
);

comment on table public.exam_sections is
  'Phase 3c: an ordered section within an exam (unique(exam_id, ordinal) — the builder UI reorders via up/down buttons, never drag-only, per DESIGN.md accessibility requirements, and reorder_exam_section below renumbers atomically to keep ordinals dense/gap-free). A section may mix fixed and pool sources (exam_section_sources).';

create index exam_sections_exam_id_idx on public.exam_sections (exam_id);

create trigger exam_sections_set_updated_at
  before update on public.exam_sections
  for each row
  execute function public.set_updated_at();

-- 3. exam_section_sources ------------------------------------------------------
-- A single table for both source kinds (documented choice: one table, not
-- two) with a CHECK enforcing "the right columns for source_type" — fixed
-- sources point at exactly one question_id and carry no pool columns; pool
-- sources carry a bank_id + optional category/difficulty/tags filter + a
-- draw_count and carry no question_id. One table keeps "list everything in
-- this section, in order" a single query instead of a UNION, which matters
-- both for the builder UI and for draw_exam_for_attempt.

create table public.exam_section_sources (
  id uuid primary key default gen_random_uuid(),
  section_id uuid not null references public.exam_sections (id) on delete cascade,
  source_type text not null check (source_type in ('fixed', 'pool')),
  ordinal int not null,
  -- fixed-source column: the exact question to include.
  question_id uuid references public.questions (id) on delete cascade,
  -- pool-source columns: draw draw_count active questions matching this spec.
  bank_id uuid references public.question_banks (id) on delete cascade,
  category_id uuid references public.question_categories (id) on delete set null,
  difficulty text check (difficulty is null or difficulty in ('easy', 'medium', 'hard')),
  tags text[],
  draw_count int check (draw_count is null or draw_count > 0),
  created_at timestamptz not null default now(),
  unique (section_id, ordinal),
  constraint exam_section_sources_shape_check check (
    (source_type = 'fixed' and question_id is not null and bank_id is null and category_id is null
      and difficulty is null and tags is null and draw_count is null)
    or
    (source_type = 'pool' and question_id is null and bank_id is not null and draw_count is not null)
  )
);

comment on table public.exam_section_sources is
  'Phase 3c: one row per question SOURCE within a section (not one row per question — a pool source can draw many). source_type=''fixed'' pins exactly one question_id (the exact wording served every attempt, subject only to option shuffling). source_type=''pool'' specifies bank_id + optional category_id/difficulty/tags + draw_count: at draw time, draw_count ACTIVE matching questions are picked pseudo-randomly per attempt (see draw_exam_for_attempt). The shape CHECK enforces the right columns are (not) set per source_type at the schema level, not just in application code. A section may freely mix fixed and pool sources — draw_exam_for_attempt concatenates all of a section''s sources in ordinal order.';
comment on column public.exam_section_sources.tags is
  'Pool filter: when set, only questions whose tags array CONTAINS every tag here match (see pool_available_count/draw_exam_for_attempt''s `tags <@ q.tags` check — pool tags must be a subset of the question''s tags, i.e. AND semantics across the filter''s tags, not OR).';

create index exam_section_sources_section_id_idx on public.exam_section_sources (section_id);
create index exam_section_sources_question_id_idx on public.exam_section_sources (question_id) where question_id is not null;
create index exam_section_sources_bank_id_idx on public.exam_section_sources (bank_id) where bank_id is not null;

-- 4. RLS ------------------------------------------------------------------
-- Policy matrix:
--   exams:
--     SELECT  owner OR lecturer_or_higher              -- KNOWN SIMPLIFICATION,
--                                                          same as classes/
--                                                          question_banks/
--                                                          forms_exams
--                                                          elsewhere in this
--                                                          codebase ("any
--                                                          lecturer" sees any
--                                                          exam). Phase 4
--                                                          scopes this to
--                                                          ownership/
--                                                          co-teaching.
--     SELECT  student, ONLY when status='published' AND now() within
--             [opens_at, closes_at] (nulls unbounded) AND the caller is a
--             class_members row for exams.class_id.
--     INSERT/UPDATE/DELETE  owner OR lecturer_or_higher
--
--   exam_sections / exam_section_sources:
--     SELECT/ALL  owner-of-exam OR lecturer_or_higher, via the parent exam.
--     NO student policy at all on either table — a student who can see a
--     published exam row (title/schedule) still gets ZERO rows from a
--     direct SELECT on sections/sources, so they never learn section
--     structure, pool filters, or (transitively, since sources reference
--     questions/banks) anything about question content ahead of time. The
--     only way to see drawn questions will be Phase 3d's attempt-scoped RPC
--     (not built here), which itself never exposes correct answers to the
--     student — draw_exam_for_attempt (which does carry answers) is
--     independently locked down below regardless.

alter table public.exams enable row level security;
alter table public.exams force row level security;

alter table public.exam_sections enable row level security;
alter table public.exam_sections force row level security;

alter table public.exam_section_sources enable row level security;
alter table public.exam_section_sources force row level security;

create policy exams_select_owner_or_lecturer
  on public.exams
  for select
  to authenticated
  using (owner_id = auth.uid() or public.has_role('lecturer'));

create policy exams_select_published_open_enrolled
  on public.exams
  for select
  to authenticated
  using (
    status = 'published'
    and (opens_at is null or opens_at <= now())
    and (closes_at is null or closes_at >= now())
    and class_id is not null
    and exists (
      select 1 from public.class_members cm
      where cm.class_id = exams.class_id
        and cm.student_id = auth.uid()
    )
  );

create policy exams_insert_owner_or_lecturer
  on public.exams
  for insert
  to authenticated
  with check (owner_id = auth.uid() and public.has_role('lecturer'));

create policy exams_update_owner_or_lecturer
  on public.exams
  for update
  to authenticated
  using (owner_id = auth.uid() or public.has_role('lecturer'))
  with check (owner_id = auth.uid() or public.has_role('lecturer'));

create policy exams_delete_owner_or_lecturer
  on public.exams
  for delete
  to authenticated
  using (owner_id = auth.uid() or public.has_role('lecturer'));

create policy exam_sections_select_via_exam
  on public.exam_sections
  for select
  to authenticated
  using (
    public.has_role('lecturer')
    or exists (
      select 1 from public.exams e
      where e.id = exam_sections.exam_id
        and e.owner_id = auth.uid()
    )
  );

create policy exam_section_sources_select_via_exam
  on public.exam_section_sources
  for select
  to authenticated
  using (
    public.has_role('lecturer')
    or exists (
      select 1
      from public.exam_sections s
      join public.exams e on e.id = s.exam_id
      where s.id = exam_section_sources.section_id
        and e.owner_id = auth.uid()
    )
  );

-- No INSERT/UPDATE/DELETE client policies for exam_sections/
-- exam_section_sources for any role: all writes go through the RPCs below
-- (security definer, each re-deriving authority from can_manage_exam()).

-- 5. helper: does the caller manage this exam? -------------------------------
-- Mirrors can_manage_question_bank exactly (20260705000010). Safe to leave
-- EXECUTE-grantable to authenticated: re-derives authority from auth.uid() +
-- has_role() itself, telling a client nothing beyond what exams' own SELECT
-- policy already implies.
create or replace function public.can_manage_exam(exam_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    auth.uid() is not null
    and (
      public.has_role('lecturer')
      or exists (
        select 1 from public.exams e
        where e.id = can_manage_exam.exam_id
          and e.owner_id = auth.uid()
      )
    );
$$;

comment on function public.can_manage_exam(uuid) is
  'True when the caller is lecturer-or-higher OR owns the given exam. Shared by every exam-builder RPC below, each of which re-derives authority through this rather than trusting a client-supplied claim.';

grant execute on function public.can_manage_exam(uuid) to authenticated;

-- 6. pool_available_count: how many active questions match a pool spec ------
create or replace function public.pool_available_count(
  bank_id uuid,
  category_id uuid default null,
  difficulty text default null,
  tags text[] default null
)
returns int
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::int
  from public.questions q
  where q.bank_id = pool_available_count.bank_id
    and q.status = 'active'
    and (pool_available_count.category_id is null or q.category_id = pool_available_count.category_id)
    and (pool_available_count.difficulty is null or q.difficulty = pool_available_count.difficulty)
    and (pool_available_count.tags is null or array_length(pool_available_count.tags, 1) is null
         or pool_available_count.tags <@ q.tags);
$$;

comment on function public.pool_available_count(uuid, uuid, text, text[]) is
  'Counts ACTIVE questions in bank_id matching the optional category/difficulty/tags filter (tags: subset match, pool_available_count.tags <@ q.tags — every requested tag must be present on the question). Used by validate_exam and by the builder UI''s live "N matching available" indicator. Does not check can_manage_exam itself (a lecturer probing bank counts while building a NEW section on an exam they will only create moments later is a normal flow) but returns 0 for a bank the caller cannot see under question_banks RLS if ever called from a plain SELECT context; called here as security definer solely to read across bank/category regardless of who owns the bank, matching bank_questions() precedent for a lecturer-or-higher-callable read helper. Caller must still be authenticated.';

grant execute on function public.pool_available_count(uuid, uuid, text, text[]) to authenticated;

-- 7. create_exam / update_exam / set_exam_status / section + source RPCs ----

create or replace function public.create_exam(
  title text,
  description text default null,
  class_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_id uuid;
  v_title text := trim(create_exam.title);
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if not public.has_role('lecturer') then
    raise exception 'Only a lecturer, admin, or super_admin may create an exam';
  end if;

  if v_title = '' then
    raise exception 'Exam title is required';
  end if;

  if create_exam.class_id is not null then
    if not exists (
      select 1 from public.classes c
      where c.id = create_exam.class_id
        and (c.owner_id = auth.uid() or public.has_role('lecturer'))
    ) then
      raise exception 'Class % not found or not manageable by the caller', class_id;
    end if;
  end if;

  insert into public.exams (owner_id, title, description, class_id)
  values (auth.uid(), v_title, create_exam.description, create_exam.class_id)
  returning id into new_id;

  perform public.log_audit('create_exam', 'exam', new_id::text, jsonb_build_object('title', v_title));

  return new_id;
end;
$$;

comment on function public.create_exam(text, text, uuid) is
  'Creates an exam owned by the caller, status=draft. Caller must be lecturer-or-higher. If class_id is given it must be a class the caller can manage. Audit-logged.';

grant execute on function public.create_exam(text, text, uuid) to authenticated;

create or replace function public.update_exam(
  exam_id uuid,
  title text,
  description text default null,
  class_id uuid default null,
  opens_at timestamptz default null,
  closes_at timestamptz default null,
  duration_minutes int default null,
  integrity_tier smallint default 2,
  violation_policy jsonb default null,
  shuffle_questions boolean default true,
  shuffle_options boolean default true,
  results_release text default 'after_close'
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_title text := trim(update_exam.title);
  v_policy jsonb;
  v_key text;
  v_entry jsonb;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if not public.can_manage_exam(update_exam.exam_id) then
    raise exception 'Only the exam owner or a lecturer-or-higher may update this exam';
  end if;

  if v_title = '' then
    raise exception 'Exam title is required';
  end if;

  if update_exam.integrity_tier is null or update_exam.integrity_tier < 1 or update_exam.integrity_tier > 4 then
    raise exception 'integrity_tier must be between 1 and 4';
  end if;

  if update_exam.results_release not in ('immediate', 'after_close', 'manual') then
    raise exception 'Unknown results_release %', update_exam.results_release;
  end if;

  if update_exam.duration_minutes is not null and update_exam.duration_minutes <= 0 then
    raise exception 'duration_minutes must be positive';
  end if;

  if update_exam.opens_at is not null and update_exam.closes_at is not null
     and update_exam.opens_at > update_exam.closes_at then
    raise exception 'opens_at must be before closes_at';
  end if;

  if update_exam.class_id is not null then
    if not exists (
      select 1 from public.classes c
      where c.id = update_exam.class_id
        and (c.owner_id = auth.uid() or public.has_role('lecturer'))
    ) then
      raise exception 'Class % not found or not manageable by the caller', class_id;
    end if;
  end if;

  -- Validate + merge violation_policy exactly like start_proctor_session
  -- (20260705000004): partial overrides, one key at a time, unknown keys or
  -- bad shapes raise rather than being silently ignored.
  v_policy := public.default_violation_policy();
  if update_exam.violation_policy is not null then
    if jsonb_typeof(update_exam.violation_policy) <> 'object' then
      raise exception 'violation_policy must be a JSON object mapping event_type to {severity, counts}';
    end if;

    for v_key, v_entry in select * from jsonb_each(update_exam.violation_policy)
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
      v_policy := jsonb_set(v_policy, array[v_key], (v_policy -> v_key) || v_entry);
    end loop;
  end if;

  update public.exams
  set title = v_title,
      description = update_exam.description,
      class_id = update_exam.class_id,
      opens_at = update_exam.opens_at,
      closes_at = update_exam.closes_at,
      duration_minutes = update_exam.duration_minutes,
      integrity_tier = update_exam.integrity_tier,
      violation_policy = v_policy,
      shuffle_questions = coalesce(update_exam.shuffle_questions, true),
      shuffle_options = coalesce(update_exam.shuffle_options, true),
      results_release = update_exam.results_release
  where id = update_exam.exam_id;

  perform public.log_audit('update_exam', 'exam', update_exam.exam_id::text, jsonb_build_object('title', v_title));
end;
$$;

comment on function public.update_exam(uuid, text, text, uuid, timestamptz, timestamptz, int, smallint, jsonb, boolean, boolean, text) is
  'Updates an exam''s settings (title/description/class/schedule/tier/policy/shuffle toggles/results-release). Owner-or-lecturer-or-higher only (can_manage_exam). violation_policy is validated + merged over default_violation_policy() exactly like start_proctor_session. Does not change status — see set_exam_status. Audit-logged.';

grant execute on function public.update_exam(uuid, text, text, uuid, timestamptz, timestamptz, int, smallint, jsonb, boolean, boolean, text) to authenticated;

-- add_exam_section --------------------------------------------------------

create or replace function public.add_exam_section(
  exam_id uuid,
  title text,
  description text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_id uuid;
  v_title text := trim(add_exam_section.title);
  next_ordinal int;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if not public.can_manage_exam(add_exam_section.exam_id) then
    raise exception 'Only the exam owner or a lecturer-or-higher may add sections to this exam';
  end if;

  if v_title = '' then
    raise exception 'Section title is required';
  end if;

  select coalesce(max(s.ordinal), 0) + 1 into next_ordinal
  from public.exam_sections s
  where s.exam_id = add_exam_section.exam_id;

  insert into public.exam_sections (exam_id, title, description, ordinal)
  values (add_exam_section.exam_id, v_title, add_exam_section.description, next_ordinal)
  returning id into new_id;

  perform public.log_audit('add_exam_section', 'exam', add_exam_section.exam_id::text, jsonb_build_object('section_id', new_id, 'title', v_title));

  return new_id;
end;
$$;

comment on function public.add_exam_section(uuid, text, text) is
  'Appends a new section at the end (ordinal = current max + 1). Owner-or-lecturer-or-higher only.';

grant execute on function public.add_exam_section(uuid, text, text) to authenticated;

-- reorder_exam_section: move a section up/down (swap ordinals) --------------
-- Accessibility requirement (DESIGN.md, task brief): up/down buttons, never
-- drag-only. This RPC is the server-side half of that — it swaps the target
-- section's ordinal with its immediate neighbor in the given direction.

create or replace function public.reorder_exam_section(
  section_id uuid,
  direction text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_exam_id uuid;
  v_ordinal int;
  v_neighbor_id uuid;
  v_neighbor_ordinal int;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if reorder_exam_section.direction not in ('up', 'down') then
    raise exception 'direction must be ''up'' or ''down''';
  end if;

  select exam_id, ordinal into v_exam_id, v_ordinal
  from public.exam_sections
  where id = reorder_exam_section.section_id;

  if v_exam_id is null then
    raise exception 'Section % not found', section_id;
  end if;

  if not public.can_manage_exam(v_exam_id) then
    raise exception 'Only the exam owner or a lecturer-or-higher may reorder this exam''s sections';
  end if;

  if reorder_exam_section.direction = 'up' then
    select id, ordinal into v_neighbor_id, v_neighbor_ordinal
    from public.exam_sections
    where exam_id = v_exam_id and ordinal < v_ordinal
    order by ordinal desc
    limit 1;
  else
    select id, ordinal into v_neighbor_id, v_neighbor_ordinal
    from public.exam_sections
    where exam_id = v_exam_id and ordinal > v_ordinal
    order by ordinal asc
    limit 1;
  end if;

  if v_neighbor_id is null then
    -- Already at the edge; no-op (not an error) so a disabled-button race
    -- from the client never surfaces as a scary failure.
    return;
  end if;

  -- Swap via a temporary negative ordinal to dodge the unique(exam_id, ordinal)
  -- constraint mid-swap.
  update public.exam_sections set ordinal = -1 where id = reorder_exam_section.section_id;
  update public.exam_sections set ordinal = v_ordinal where id = v_neighbor_id;
  update public.exam_sections set ordinal = v_neighbor_ordinal where id = reorder_exam_section.section_id;
end;
$$;

comment on function public.reorder_exam_section(uuid, text) is
  'Swaps a section''s ordinal with its immediate up/down neighbor (accessibility requirement: up/down buttons, never drag-only). No-op at either edge. Owner-or-lecturer-or-higher only.';

grant execute on function public.reorder_exam_section(uuid, text) to authenticated;

-- remove_exam_section --------------------------------------------------------

create or replace function public.remove_exam_section(section_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_exam_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select exam_id into v_exam_id from public.exam_sections where id = remove_exam_section.section_id;
  if v_exam_id is null then
    raise exception 'Section % not found', section_id;
  end if;

  if not public.can_manage_exam(v_exam_id) then
    raise exception 'Only the exam owner or a lecturer-or-higher may remove this section';
  end if;

  delete from public.exam_sections where id = remove_exam_section.section_id;

  perform public.log_audit('remove_exam_section', 'exam', v_exam_id::text, jsonb_build_object('section_id', section_id));
end;
$$;

comment on function public.remove_exam_section(uuid) is
  'Deletes a section (cascades to its sources). Owner-or-lecturer-or-higher only. Leaves a gap in ordinals, which is fine — ordering only needs to be monotonic, not dense.';

grant execute on function public.remove_exam_section(uuid) to authenticated;

-- add_section_source (fixed or pool) -----------------------------------------

create or replace function public.add_section_source(
  section_id uuid,
  source_type text,
  question_id uuid default null,
  bank_id uuid default null,
  category_id uuid default null,
  difficulty text default null,
  tags text[] default null,
  draw_count int default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_id uuid;
  v_exam_id uuid;
  next_ordinal int;
  v_question_bank_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select s.exam_id into v_exam_id from public.exam_sections s where s.id = add_section_source.section_id;
  if v_exam_id is null then
    raise exception 'Section % not found', section_id;
  end if;

  if not public.can_manage_exam(v_exam_id) then
    raise exception 'Only the exam owner or a lecturer-or-higher may add sources to this section';
  end if;

  if add_section_source.source_type not in ('fixed', 'pool') then
    raise exception 'source_type must be ''fixed'' or ''pool''';
  end if;

  if add_section_source.source_type = 'fixed' then
    if add_section_source.question_id is null then
      raise exception 'fixed sources require question_id';
    end if;
    select q.bank_id into v_question_bank_id from public.questions q where q.id = add_section_source.question_id;
    if v_question_bank_id is null then
      raise exception 'Question % not found', question_id;
    end if;
    if not public.can_manage_question_bank(v_question_bank_id) then
      raise exception 'Only the bank owner or a lecturer-or-higher may use this question';
    end if;

    insert into public.exam_section_sources (section_id, source_type, ordinal, question_id)
    select add_section_source.section_id, 'fixed',
           coalesce(max(s.ordinal), 0) + 1, add_section_source.question_id
    from public.exam_section_sources s
    where s.section_id = add_section_source.section_id
    returning id into new_id;
  else
    if add_section_source.bank_id is null then
      raise exception 'pool sources require bank_id';
    end if;
    if add_section_source.draw_count is null or add_section_source.draw_count <= 0 then
      raise exception 'pool sources require a positive draw_count';
    end if;
    if not public.can_manage_question_bank(add_section_source.bank_id) then
      raise exception 'Only the bank owner or a lecturer-or-higher may draw from this bank';
    end if;
    if add_section_source.difficulty is not null and add_section_source.difficulty not in ('easy', 'medium', 'hard') then
      raise exception 'Unknown difficulty %', add_section_source.difficulty;
    end if;
    if add_section_source.category_id is not null and not exists (
      select 1 from public.question_categories c
      where c.id = add_section_source.category_id and c.bank_id = add_section_source.bank_id
    ) then
      raise exception 'Category % does not belong to bank %', category_id, bank_id;
    end if;

    insert into public.exam_section_sources
      (section_id, source_type, ordinal, bank_id, category_id, difficulty, tags, draw_count)
    select add_section_source.section_id, 'pool',
           coalesce(max(s.ordinal), 0) + 1,
           add_section_source.bank_id, add_section_source.category_id, add_section_source.difficulty,
           add_section_source.tags, add_section_source.draw_count
    from public.exam_section_sources s
    where s.section_id = add_section_source.section_id
    returning id into new_id;
  end if;

  perform public.log_audit(
    'add_section_source', 'exam', v_exam_id::text,
    jsonb_build_object('section_id', section_id, 'source_id', new_id, 'source_type', source_type)
  );

  return new_id;
end;
$$;

comment on function public.add_section_source(uuid, text, uuid, uuid, uuid, text, text[], int) is
  'Adds a fixed or pool question source to a section, appended at the end (ordinal = current max + 1). Fixed sources re-check can_manage_question_bank() on the target question''s bank; pool sources re-check it on bank_id directly, and validate category_id belongs to that bank. Owner-or-lecturer-or-higher on the EXAM is required first; this additionally requires manage rights on the referenced bank, so a lecturer cannot silently pull questions from a bank they cannot manage into their own exam.';

grant execute on function public.add_section_source(uuid, text, uuid, uuid, uuid, text, text[], int) to authenticated;

-- remove_section_source -------------------------------------------------------

create or replace function public.remove_section_source(source_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_exam_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select e.id into v_exam_id
  from public.exam_section_sources src
  join public.exam_sections s on s.id = src.section_id
  join public.exams e on e.id = s.exam_id
  where src.id = remove_section_source.source_id;

  if v_exam_id is null then
    raise exception 'Source % not found', source_id;
  end if;

  if not public.can_manage_exam(v_exam_id) then
    raise exception 'Only the exam owner or a lecturer-or-higher may remove this source';
  end if;

  delete from public.exam_section_sources where id = remove_section_source.source_id;

  perform public.log_audit('remove_section_source', 'exam', v_exam_id::text, jsonb_build_object('source_id', source_id));
end;
$$;

comment on function public.remove_section_source(uuid) is
  'Deletes a section source. Owner-or-lecturer-or-higher only.';

grant execute on function public.remove_section_source(uuid) to authenticated;

-- 8. validate_exam ------------------------------------------------------------

create or replace function public.validate_exam(exam_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_issues text[] := '{}';
  v_exam record;
  v_section record;
  v_source record;
  v_section_count int;
  v_source_count int;
  v_available int;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if not public.can_manage_exam(validate_exam.exam_id) then
    raise exception 'Only the exam owner or a lecturer-or-higher may validate this exam';
  end if;

  select * into v_exam from public.exams where id = validate_exam.exam_id;
  if v_exam.id is null then
    raise exception 'Exam % not found', exam_id;
  end if;

  if v_exam.class_id is null then
    v_issues := v_issues || 'No class is assigned — students will never see this exam.';
  end if;

  select count(*) into v_section_count from public.exam_sections s where s.exam_id = validate_exam.exam_id;
  if v_section_count = 0 then
    v_issues := v_issues || 'The exam has no sections.';
  end if;

  for v_section in
    select * from public.exam_sections s where s.exam_id = validate_exam.exam_id order by s.ordinal
  loop
    select count(*) into v_source_count
    from public.exam_section_sources
    where section_id = v_section.id;

    if v_source_count = 0 then
      v_issues := v_issues || format('Section "%s" has no question sources.', v_section.title);
      continue;
    end if;

    for v_source in
      select * from public.exam_section_sources where section_id = v_section.id order by ordinal
    loop
      if v_source.source_type = 'pool' then
        v_available := public.pool_available_count(
          v_source.bank_id, v_source.category_id, v_source.difficulty, v_source.tags
        );
        if v_available < v_source.draw_count then
          v_issues := v_issues || format(
            'Section "%s": pool source needs %s question(s) but only %s are available.',
            v_section.title, v_source.draw_count, v_available
          );
        end if;
      else
        if not exists (
          select 1 from public.questions q where q.id = v_source.question_id and q.status = 'active'
        ) then
          v_issues := v_issues || format(
            'Section "%s": a fixed question is missing or retired.', v_section.title
          );
        end if;
      end if;
    end loop;
  end loop;

  return jsonb_build_object('ok', array_length(v_issues, 1) is null, 'issues', to_jsonb(v_issues));
end;
$$;

comment on function public.validate_exam(uuid) is
  'Owner-or-lecturer-or-higher readiness check: every section has >=1 source, every pool source has enough ACTIVE matching questions for its draw_count, every fixed source still points at an active question, and a class is assigned. Returns {ok: boolean, issues: string[]}. set_exam_status(''published'') calls this and refuses to publish when ok=false.';

grant execute on function public.validate_exam(uuid) to authenticated;

-- 9. set_exam_status (publish gated by validate_exam) ------------------------

create or replace function public.set_exam_status(
  exam_id uuid,
  status text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_validation jsonb;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if set_exam_status.status not in ('draft', 'published', 'closed') then
    raise exception 'Unknown status %', set_exam_status.status;
  end if;

  if not public.can_manage_exam(set_exam_status.exam_id) then
    raise exception 'Only the exam owner or a lecturer-or-higher may change this exam''s status';
  end if;

  if set_exam_status.status = 'published' then
    v_validation := public.validate_exam(set_exam_status.exam_id);
    if not (v_validation ->> 'ok')::boolean then
      raise exception 'Cannot publish: %', (v_validation -> 'issues');
    end if;
  end if;

  update public.exams set status = set_exam_status.status where id = set_exam_status.exam_id;

  perform public.log_audit(
    'set_exam_status', 'exam', set_exam_status.exam_id::text, jsonb_build_object('status', set_exam_status.status)
  );
end;
$$;

comment on function public.set_exam_status(uuid, text) is
  'Changes exam status. Publishing (status=''published'') FIRST calls validate_exam() and raises with the issue list if not ok — this is the enforcement point for "validation-gated publish", not just a UI nicety, since this RPC is the only sanctioned way to flip status. Owner-or-lecturer-or-higher only. Audit-logged.';

grant execute on function public.set_exam_status(uuid, text) to authenticated;

-- 10. draw_exam_for_attempt — THE core seeded draw, LOCKED DOWN -------------
-- Deterministic given (exam definition + seed): for each section (in
-- ordinal order, or shuffled if exams.shuffle_questions), resolves its
-- sources in order — fixed sources contribute their pinned question,
-- pool sources draw draw_count ACTIVE matching questions ordered by
-- md5(seed || question_id) (a cheap, deterministic, evenly-distributed
-- pseudo-random ordering keyed off the seed: same seed -> same draw, every
-- time, with no separate random-state table to manage). current_version_id
-- is resolved and embedded in the result AS OF THIS CALL ("frozen") — a
-- later add_question_version() on the same logical question does not change
-- what an already-drawn attempt sees, because the version_id (not the
-- mutable question_id -> current_version_id pointer) is what gets returned
-- and, in Phase 3d, what exam_attempts will store.
--
-- Returns the FULL frozen structure INCLUDING correct answers (body as
-- stored, unredacted) — this is by design (Phase 3d's attempt-creation code
-- needs the answer key to grade later) and is exactly why EXECUTE is
-- revoked from public/anon/authenticated immediately below. A student must
-- never be able to call this directly; only the service role (Phase 3d) and
-- preview_exam_draw (lecturer-only, re-derives authority) may reach it.
create or replace function public.draw_exam_for_attempt(
  exam_id uuid,
  seed text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_section record;
  v_source record;
  v_sections jsonb := '[]'::jsonb;
  v_section_questions jsonb;
  v_question record;
  v_options jsonb;
  v_opt record;
  v_question_json jsonb;
  v_section_ordinal_key text;
begin
  if seed is null or length(trim(seed)) = 0 then
    raise exception 'seed is required';
  end if;

  if not exists (select 1 from public.exams where id = draw_exam_for_attempt.exam_id) then
    raise exception 'Exam % not found', exam_id;
  end if;

  for v_section in
    select s.*
    from public.exam_sections s
    where s.exam_id = draw_exam_for_attempt.exam_id
    order by
      case when (select shuffle_questions from public.exams where id = draw_exam_for_attempt.exam_id)
        then md5(draw_exam_for_attempt.seed || ':section:' || s.id::text)
        else lpad(s.ordinal::text, 10, '0')
      end
  loop
    v_section_questions := '[]'::jsonb;

    for v_source in
      select * from public.exam_section_sources where section_id = v_section.id order by ordinal
    loop
      if v_source.source_type = 'fixed' then
        select q.id as question_id, q.type, qv.id as version_id, qv.prompt, qv.body
        into v_question
        from public.questions q
        join public.question_versions qv on qv.id = q.current_version_id
        where q.id = v_source.question_id;

        if v_question.question_id is not null then
          v_question_json := jsonb_build_object(
            'question_id', v_question.question_id,
            'version_id', v_question.version_id,
            'type', v_question.type,
            'prompt', v_question.prompt,
            'body', v_question.body
          );
          v_section_questions := v_section_questions || jsonb_build_array(v_question_json);
        end if;
      else
        for v_question in
          select q.id as question_id, q.type, qv.id as version_id, qv.prompt, qv.body
          from public.questions q
          join public.question_versions qv on qv.id = q.current_version_id
          where q.bank_id = v_source.bank_id
            and q.status = 'active'
            and (v_source.category_id is null or q.category_id = v_source.category_id)
            and (v_source.difficulty is null or q.difficulty = v_source.difficulty)
            and (v_source.tags is null or array_length(v_source.tags, 1) is null or v_source.tags <@ q.tags)
          order by md5(draw_exam_for_attempt.seed || ':question:' || v_source.id::text || ':' || q.id::text)
          limit v_source.draw_count
        loop
          v_question_json := jsonb_build_object(
            'question_id', v_question.question_id,
            'version_id', v_question.version_id,
            'type', v_question.type,
            'prompt', v_question.prompt,
            'body', v_question.body
          );
          v_section_questions := v_section_questions || jsonb_build_array(v_question_json);
        end loop;
      end if;
    end loop;

    -- Per-question option shuffle (mcq_single/mcq_multi/true_false: only
    -- mcq has an `options` array to shuffle; true_false/numeric/short_answer/
    -- essay bodies are returned as-is regardless of shuffle_options).
    if (select shuffle_options from public.exams where id = draw_exam_for_attempt.exam_id) then
      v_section_questions := (
        select coalesce(jsonb_agg(
          case
            when elem -> 'body' ? 'options' then
              jsonb_set(
                elem,
                '{body,options}',
                (
                  select coalesce(jsonb_agg(opt order by md5(draw_exam_for_attempt.seed || ':option:' || (elem->>'version_id') || ':' || (opt->>'id'))), '[]'::jsonb)
                  from jsonb_array_elements(elem -> 'body' -> 'options') opt
                )
              )
            else elem
          end
        ), '[]'::jsonb)
        from jsonb_array_elements(v_section_questions) elem
      );
    end if;

    -- Optional within-section question shuffle (already ordered by fixed
    -- ordinal for fixed sources / pool draw order above; if
    -- shuffle_questions is on, reshuffle the whole section's question list
    -- too, not just section order).
    if (select shuffle_questions from public.exams where id = draw_exam_for_attempt.exam_id) then
      v_section_questions := (
        select coalesce(jsonb_agg(elem order by md5(draw_exam_for_attempt.seed || ':qorder:' || v_section.id::text || ':' || (elem->>'version_id'))), '[]'::jsonb)
        from jsonb_array_elements(v_section_questions) elem
      );
    end if;

    v_sections := v_sections || jsonb_build_array(
      jsonb_build_object(
        'section_id', v_section.id,
        'title', v_section.title,
        'description', v_section.description,
        'questions', v_section_questions
      )
    );
  end loop;

  return jsonb_build_object(
    'exam_id', draw_exam_for_attempt.exam_id,
    'seed', draw_exam_for_attempt.seed,
    'sections', v_sections
  );
end;
$$;

comment on function public.draw_exam_for_attempt(uuid, text) is
  'THE core per-attempt deterministic seeded draw (PLAN.md RESEARCH.md sec 4: N-from-pool/per-student randomization is a core anti-cheat layer). Same (exam definition, seed) ALWAYS returns the same result — ordering and pool selection are both derived from md5(seed || ...), never actual randomness — so it is reproducible for grading/audit while still being different per attempt (each attempt gets its own seed in Phase 3d). Freezes current_version_id AT CALL TIME into each returned question (version_id, not question_id, is what a Phase 3d exam_attempt will store), so later edits to a question never retroactively change an already-drawn attempt. Returns FULL body INCLUDING correct answers — LOCKED DOWN below: EXECUTE revoked from public/anon/authenticated immediately after creation. Only the service role (future Phase 3d attempt-creation code) and preview_exam_draw (owner/lecturer-only wrapper) may call it.';

-- LOCK DOWN: this function exposes correct answers and must never be
-- directly client-reachable, exactly like _create_proctor_session
-- (20260705000006). Revoke immediately after creation — Postgres grants
-- EXECUTE to PUBLIC by default, and Supabase additionally grants it to
-- anon/authenticated, so an explicit revoke is required, not just omitting
-- a GRANT.
revoke execute on function public.draw_exam_for_attempt(uuid, text) from public, anon, authenticated;

-- 11. preview_exam_draw — lecturer/owner-only preview wrapper ----------------
-- Re-derives authority (owner-or-lecturer-or-higher) independently, then
-- calls draw_exam_for_attempt with a throwaway seed. Runs as the function
-- owner (postgres), which retains its own EXECUTE grant on
-- draw_exam_for_attempt despite the revoke above — the same trust
-- relationship start_forms_exam_session has with _create_proctor_session.
create or replace function public.preview_exam_draw(exam_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_seed text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if not public.can_manage_exam(preview_exam_draw.exam_id) then
    raise exception 'Only the exam owner or a lecturer-or-higher may preview this exam''s draw';
  end if;

  v_seed := 'preview:' || gen_random_uuid()::text;

  return public.draw_exam_for_attempt(preview_exam_draw.exam_id, v_seed);
end;
$$;

comment on function public.preview_exam_draw(uuid) is
  'Owner-or-lecturer-or-higher-only preview of a sample drawn paper (fresh throwaway seed each call, so repeated previews show different pool picks). Answers ARE included in the result — acceptable because the caller already has authoring access to every question here. Never exposed to students. Re-derives authority independently rather than trusting the client, exactly like every other RPC in this migration.';

grant execute on function public.preview_exam_draw(uuid) to authenticated;
