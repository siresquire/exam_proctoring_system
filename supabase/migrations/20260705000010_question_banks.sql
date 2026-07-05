-- Phase 3b: question banks — categories, VERSIONED questions, per-type
-- authoring, bulk import (schema half; parsers + UI live in apps/web).
--
-- This is authoring only (PLAN.md Phase 3 decomposition): the exam builder
-- (draw/shuffle) is 3c and the exam room is 3d. Students get NO access to
-- any table in this migration — exam delivery in 3d will expose only the
-- drawn, sanitized question content (no `correct` fields) via its own RPC,
-- never a direct SELECT on `questions`/`question_versions`.
--
-- Security posture, same as every prior migration: RLS enabled + forced on
-- every table, has_role()/is_admin_or_higher() for role checks (super_admin
-- universal), security-definer RPCs with `set search_path = ''`. Per the
-- task brief, the 20260705000006 EXECUTE-revoke lock-down pattern applies
-- only to helpers that TRUST their arguments instead of re-deriving
-- authority from auth.uid() — none of the RPCs below need it, because each
-- one independently re-checks "does the caller manage this bank" from
-- auth.uid() + has_role('lecturer'), exactly like 3a's create_class/
-- enroll_existing_student (see that migration's header comment). Verified
-- with a negative smoke test (scripts/rls-smoke-test.mjs section (n)): a
-- student calling create_question directly is denied.

-- 1. question_banks -----------------------------------------------------------

create table public.question_banks (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.question_banks is
  'Phase 3b: a lecturer- or admin-owned collection of questions. RLS policy is owner-or-lecturer-or-higher for manage/select — the same KNOWN SIMPLIFICATION as classes/forms_exams elsewhere in this codebase ("any lecturer" can see/manage any bank, not just banks they own). Phase 4 scopes this to ownership/co-teaching once there is a concept of shared course teams.';

create index question_banks_owner_id_idx on public.question_banks (owner_id);

create trigger question_banks_set_updated_at
  before update on public.question_banks
  for each row
  execute function public.set_updated_at();

-- create_question_bank RPC: mirrors create_class (20260705000008) — a thin
-- audit-logged wrapper rather than a bare client INSERT, even though the
-- question_banks_insert_owner_or_lecturer RLS policy below would also allow
-- a direct .insert() call. Using the RPC keeps bank creation in the audit
-- trail the same way every other "create a top-level owned resource" action
-- in this codebase is logged.
create or replace function public.create_question_bank(
  name text,
  description text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_id uuid;
  v_name text := trim(create_question_bank.name);
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if not public.has_role('lecturer') then
    raise exception 'Only a lecturer, admin, or super_admin may create a question bank';
  end if;

  if v_name = '' then
    raise exception 'Bank name is required';
  end if;

  insert into public.question_banks (owner_id, name, description)
  values (auth.uid(), v_name, create_question_bank.description)
  returning id into new_id;

  perform public.log_audit(
    'create_question_bank',
    'question_bank',
    new_id::text,
    jsonb_build_object('name', v_name)
  );

  return new_id;
end;
$$;

comment on function public.create_question_bank(text, text) is
  'Creates a question bank owned by the caller. Caller must be lecturer-or-higher. Audit-logged. Mirrors create_class exactly.';

grant execute on function public.create_question_bank(text, text) to authenticated;

-- 2. question_categories (self-referencing tree, scoped to one bank) ----------

create table public.question_categories (
  id uuid primary key default gen_random_uuid(),
  bank_id uuid not null references public.question_banks (id) on delete cascade,
  parent_id uuid references public.question_categories (id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  unique (bank_id, parent_id, name)
);

comment on table public.question_categories is
  'Phase 3b: a category tree scoped to one bank (parent_id self-references within the same bank; not cross-checked by a trigger since a category is always created via create/rename RPCs — see apps/web — that already scope parent lookups to bank_id). unique(bank_id, parent_id, name) allows the same name at different tree levels or in different banks, but not two siblings with the same name under the same parent (parent_id null = top-level, and Postgres treats NULL as distinct per row in a unique index — see the partial-unique-index workaround below).';

create index question_categories_bank_id_idx on public.question_categories (bank_id);
create index question_categories_parent_id_idx on public.question_categories (parent_id);

-- Postgres unique constraints treat NULL as distinct from every other NULL,
-- so `unique (bank_id, parent_id, name)` alone would NOT stop two top-level
-- ("parent_id is null") categories in the same bank from sharing a name.
-- Cover that case with a partial unique index; the table-level constraint
-- above still handles every non-null-parent case.
create unique index question_categories_bank_root_name_idx
  on public.question_categories (bank_id, name)
  where parent_id is null;

-- 3. questions (the LOGICAL question — stable id across edits) ----------------

create table public.questions (
  id uuid primary key default gen_random_uuid(),
  bank_id uuid not null references public.question_banks (id) on delete cascade,
  category_id uuid references public.question_categories (id) on delete set null,
  type text not null check (
    type in ('mcq_single', 'mcq_multi', 'true_false', 'numeric', 'short_answer', 'essay')
  ),
  difficulty text not null default 'medium' check (difficulty in ('easy', 'medium', 'hard')),
  tags text[] not null default '{}',
  status text not null default 'active' check (status in ('active', 'retired')),
  -- Nullable only for the instant between the questions INSERT and the
  -- question_versions INSERT inside create_question()'s single transaction;
  -- every row a client can ever SELECT has this set (create_question sets it
  -- before returning, all in one function invocation = one transaction).
  current_version_id uuid,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.questions is
  'Phase 3b: the LOGICAL question — stable id, type, difficulty, tags, status. The actual prompt/answer content lives in question_versions and is never stored here, so "editing a question" never mutates graded history (see question_versions comment). current_version_id points at the version currently shown to authors/used for new draws; past exam_attempts (Phase 3c/3d) will instead pin the exact version_id they were served, independent of this pointer moving forward.';

create index questions_bank_id_idx on public.questions (bank_id);
create index questions_category_id_idx on public.questions (category_id);
create index questions_status_idx on public.questions (status);
create index questions_tags_idx on public.questions using gin (tags);

create trigger questions_set_updated_at
  before update on public.questions
  for each row
  execute function public.set_updated_at();

-- 4. question_versions (the CONTENT — append-only, never edited in place) -----
--
-- body jsonb shape per questions.type (documented here as the single source
-- of truth; validated minimally by create_question/add_question_version):
--   mcq_single / mcq_multi:
--     { "options": [{"id": string, "text": string}, ...],
--       "correct": [optionId, ...],   -- exactly 1 for mcq_single, >=1 for mcq_multi
--       "marks": number }
--   true_false:
--     { "correct": boolean, "marks": number }
--   numeric:
--     { "correct": number, "tolerance": number, "marks": number }
--   short_answer:
--     { "accepted": [string, ...], "case_sensitive": boolean, "marks": number }
--     -- accepted answers enable optional auto-grade later (Phase 3d).
--   essay:
--     { "marks": number, "rubric": string }   -- manually graded in Phase 3d.

create table public.question_versions (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references public.questions (id) on delete cascade,
  version_no int not null check (version_no > 0),
  prompt text not null,
  body jsonb not null,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  unique (question_id, version_no)
);

comment on table public.question_versions is
  'Phase 3b: append-only question CONTENT. A version is never edited in place — "editing" a question means add_question_version() inserts a NEW row and repoints questions.current_version_id at it (see that RPC). This keeps every version that was ever served to a student addressable by id forever, so a Phase 3c/3d exam_attempt that recorded "student answered version_id=X" stays auditable against the exact wording served, even after the question is edited a dozen times. Deletion still cascades with the parent question (retiring/removing a question removes its history too — versioning protects against silent edits, not against the question being deleted outright). body shape documented on this table comment above, keyed by the parent questions.type.';

create index question_versions_question_id_idx on public.question_versions (question_id);

-- Immutability trigger: block UPDATE of prompt/body on an EXISTING version
-- row. created_by/created_at/version_no/question_id are likewise part of the
-- row's permanent identity and blocked too — the only sanctioned way to
-- change a version's content is to insert a new version via
-- add_question_version(). DELETE is intentionally NOT blocked here (cascade
-- deletion when the parent question is deleted must still work).
create or replace function public.question_versions_immutable()
returns trigger
language plpgsql
as $$
begin
  raise exception 'question_versions rows are immutable: create a new version via add_question_version() instead of updating version %', old.id;
end;
$$;

comment on function public.question_versions_immutable() is
  'Blocks UPDATE on question_versions (belt-and-braces alongside no client UPDATE grant/policy — see RLS section below). DELETE is unrestricted at the trigger level so ON DELETE CASCADE from questions still works.';

create trigger question_versions_no_update
  before update on public.question_versions
  for each row
  execute function public.question_versions_immutable();

-- Belt: without an explicit UPDATE grant, an UPDATE with no matching RLS
-- policy does not raise — it silently matches 0 rows and reports success
-- (this bit both the audit_log design, hence its own explicit revoke, and
-- was caught here empirically by rls-smoke-test.mjs r15 initially passing
-- for the wrong reason). Revoking UPDATE outright turns "quietly a no-op"
-- into a real permission-denied error, AND is a second independent layer
-- alongside the question_versions_no_update trigger above (belt-and-braces,
-- same posture as audit_log_immutable in 20260704000002_audit_log.sql).
revoke update on public.question_versions from anon, authenticated;

-- 5. RLS ------------------------------------------------------------------
-- Policy matrix (mirrors classes/class_members in 20260705000008):
--   question_banks:     SELECT/INSERT/UPDATE/DELETE  owner OR lecturer_or_higher
--   question_categories: SELECT/ALL via the parent bank's ownership
--   questions:            SELECT/ALL via the parent bank's ownership
--   question_versions:    SELECT/ALL via the parent question's bank's ownership
--
-- Students get NO policy on any of these four tables — RLS is force-enabled
-- with no student-facing policy at all, so a direct client SELECT returns
-- zero rows regardless of query shape. Exam delivery (Phase 3d) will expose
-- only drawn, sanitized question content (no `correct` fields) through its
-- own security-definer RPC, never these tables directly.

alter table public.question_banks enable row level security;
alter table public.question_banks force row level security;

alter table public.question_categories enable row level security;
alter table public.question_categories force row level security;

alter table public.questions enable row level security;
alter table public.questions force row level security;

alter table public.question_versions enable row level security;
alter table public.question_versions force row level security;

create policy question_banks_select_owner_or_lecturer
  on public.question_banks
  for select
  to authenticated
  using (owner_id = auth.uid() or public.has_role('lecturer'));

create policy question_banks_insert_owner_or_lecturer
  on public.question_banks
  for insert
  to authenticated
  with check (owner_id = auth.uid() and public.has_role('lecturer'));

create policy question_banks_update_owner_or_lecturer
  on public.question_banks
  for update
  to authenticated
  using (owner_id = auth.uid() or public.has_role('lecturer'))
  with check (owner_id = auth.uid() or public.has_role('lecturer'));

create policy question_banks_delete_owner_or_lecturer
  on public.question_banks
  for delete
  to authenticated
  using (owner_id = auth.uid() or public.has_role('lecturer'));

-- question_categories: gated via the parent bank's ownership. No separate
-- INSERT/UPDATE/DELETE client policy — categories are only ever written via
-- the RPCs below (security definer), which perform the same ownership check
-- before writing. SELECT is a direct client policy (read-only path used by
-- the category tree UI) since there's no sensitive content to hide here
-- beyond bank-level access.
create policy question_categories_select_via_bank
  on public.question_categories
  for select
  to authenticated
  using (
    public.has_role('lecturer')
    or exists (
      select 1 from public.question_banks b
      where b.id = question_categories.bank_id
        and b.owner_id = auth.uid()
    )
  );

create policy questions_select_via_bank
  on public.questions
  for select
  to authenticated
  using (
    public.has_role('lecturer')
    or exists (
      select 1 from public.question_banks b
      where b.id = questions.bank_id
        and b.owner_id = auth.uid()
    )
  );

create policy question_versions_select_via_question_bank
  on public.question_versions
  for select
  to authenticated
  using (
    public.has_role('lecturer')
    or exists (
      select 1
      from public.questions q
      join public.question_banks b on b.id = q.bank_id
      where q.id = question_versions.question_id
        and b.owner_id = auth.uid()
    )
  );

-- No INSERT/UPDATE/DELETE policies for question_categories/questions/
-- question_versions for any client role: all writes go through the RPCs
-- below (security definer, each re-deriving authority from auth.uid() +
-- has_role/bank ownership before writing).

-- 6. helper: does the caller manage this bank? --------------------------------
-- Small internal helper shared by every RPC below to avoid repeating the
-- same EXISTS check five times. SAFE to leave EXECUTE-grantable to
-- authenticated (no lock-down needed): it re-derives authority from
-- auth.uid() + has_role() itself rather than trusting a caller-supplied
-- claim, so calling it directly tells a client nothing it couldn't already
-- infer from question_banks' own SELECT policy.
create or replace function public.can_manage_question_bank(bank_id uuid)
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
        select 1 from public.question_banks b
        where b.id = can_manage_question_bank.bank_id
          and b.owner_id = auth.uid()
      )
    );
$$;

comment on function public.can_manage_question_bank(uuid) is
  'True when the caller is lecturer-or-higher (has_role universal super_admin pass-through included) OR owns the given bank. Shared by create_question/add_question_version/set_question_status/category RPCs — every one of them re-derives authority through this function rather than trusting an is-owner flag passed by the client.';

grant execute on function public.can_manage_question_bank(uuid) to authenticated;

-- 7. create_question RPC -------------------------------------------------------

create or replace function public.create_question(
  bank_id uuid,
  type text,
  category_id uuid default null,
  difficulty text default 'medium',
  tags text[] default '{}',
  prompt text default '',
  body jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_question_id uuid;
  new_version_id uuid;
  v_prompt text := trim(create_question.prompt);
  v_marks numeric;
  v_options jsonb;
  v_correct jsonb;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if not public.can_manage_question_bank(create_question.bank_id) then
    raise exception 'Only the bank owner or a lecturer-or-higher may add questions to this bank';
  end if;

  if create_question.type not in ('mcq_single', 'mcq_multi', 'true_false', 'numeric', 'short_answer', 'essay') then
    raise exception 'Unknown question type %', create_question.type;
  end if;

  if create_question.difficulty not in ('easy', 'medium', 'hard') then
    raise exception 'Unknown difficulty %', create_question.difficulty;
  end if;

  if v_prompt = '' then
    raise exception 'Question prompt is required';
  end if;

  if create_question.category_id is not null then
    if not exists (
      select 1 from public.question_categories c
      where c.id = create_question.category_id
        and c.bank_id = create_question.bank_id
    ) then
      raise exception 'Category % does not belong to bank %', create_question.category_id, create_question.bank_id;
    end if;
  end if;

  -- Minimal per-type body validation. This is deliberately not exhaustive
  -- (full pedagogical validation belongs in the UI/import-preview layer) —
  -- the goal here is to reject shapes that would corrupt grading later
  -- (Phase 3d), not to police wording quality.
  v_marks := nullif(create_question.body->>'marks', '')::numeric;
  if v_marks is null or v_marks <= 0 then
    raise exception 'body.marks must be a positive number';
  end if;

  if create_question.type in ('mcq_single', 'mcq_multi') then
    v_options := create_question.body->'options';
    v_correct := create_question.body->'correct';
    if v_options is null or jsonb_typeof(v_options) <> 'array' or jsonb_array_length(v_options) < 2 then
      raise exception 'mcq questions require at least 2 options';
    end if;
    if v_correct is null or jsonb_typeof(v_correct) <> 'array' or jsonb_array_length(v_correct) < 1 then
      raise exception 'mcq questions require at least 1 correct option';
    end if;
    if create_question.type = 'mcq_single' and jsonb_array_length(v_correct) <> 1 then
      raise exception 'mcq_single requires exactly 1 correct option';
    end if;
  elsif create_question.type = 'true_false' then
    if jsonb_typeof(create_question.body->'correct') <> 'boolean' then
      raise exception 'true_false requires body.correct to be a boolean';
    end if;
  elsif create_question.type = 'numeric' then
    if nullif(create_question.body->>'correct', '') is null then
      raise exception 'numeric requires body.correct to be a number';
    end if;
    perform (create_question.body->>'correct')::numeric;
    if nullif(create_question.body->>'tolerance', '') is not null then
      perform (create_question.body->>'tolerance')::numeric;
    end if;
  elsif create_question.type = 'short_answer' then
    if create_question.body->'accepted' is null
      or jsonb_typeof(create_question.body->'accepted') <> 'array'
      or jsonb_array_length(create_question.body->'accepted') < 1
    then
      raise exception 'short_answer requires at least 1 accepted answer';
    end if;
  elsif create_question.type = 'essay' then
    null; -- marks already validated above; rubric is optional free text.
  end if;

  insert into public.questions (bank_id, category_id, type, difficulty, tags, created_by)
  values (
    create_question.bank_id,
    create_question.category_id,
    create_question.type,
    create_question.difficulty,
    coalesce(create_question.tags, '{}'),
    auth.uid()
  )
  returning id into new_question_id;

  insert into public.question_versions (question_id, version_no, prompt, body, created_by)
  values (new_question_id, 1, v_prompt, create_question.body, auth.uid())
  returning id into new_version_id;

  update public.questions set current_version_id = new_version_id where id = new_question_id;

  perform public.log_audit(
    'create_question',
    'question',
    new_question_id::text,
    jsonb_build_object('bank_id', create_question.bank_id, 'type', create_question.type)
  );

  return new_question_id;
end;
$$;

comment on function public.create_question(uuid, text, uuid, text, text[], text, jsonb) is
  'Creates a question + its version 1 in one transaction, sets current_version_id, and audit-logs. Caller must pass can_manage_question_bank() for bank_id (owner-or-lecturer-or-higher) — re-derived from auth.uid() here, never trusted from the client. Validates type/difficulty against the fixed vocabularies and does minimal per-type body shape validation (options/correct/marks presence) — see the question_versions table comment for the full documented body shapes.';

grant execute on function public.create_question(uuid, text, uuid, text, text[], text, jsonb) to authenticated;

-- 8. add_question_version RPC — this is how "editing" works -------------------

create or replace function public.add_question_version(
  question_id uuid,
  prompt text,
  body jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_bank_id uuid;
  v_type text;
  v_prompt text := trim(add_question_version.prompt);
  v_marks numeric;
  new_version_id uuid;
  next_version_no int;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select bank_id, type into v_bank_id, v_type
  from public.questions
  where id = add_question_version.question_id;

  if v_bank_id is null then
    raise exception 'Question % not found', question_id;
  end if;

  if not public.can_manage_question_bank(v_bank_id) then
    raise exception 'Only the bank owner or a lecturer-or-higher may edit this question';
  end if;

  if v_prompt = '' then
    raise exception 'Question prompt is required';
  end if;

  v_marks := nullif(add_question_version.body->>'marks', '')::numeric;
  if v_marks is null or v_marks <= 0 then
    raise exception 'body.marks must be a positive number';
  end if;

  if v_type in ('mcq_single', 'mcq_multi') then
    if add_question_version.body->'options' is null
      or jsonb_typeof(add_question_version.body->'options') <> 'array'
      or jsonb_array_length(add_question_version.body->'options') < 2
    then
      raise exception 'mcq questions require at least 2 options';
    end if;
    if add_question_version.body->'correct' is null
      or jsonb_typeof(add_question_version.body->'correct') <> 'array'
      or jsonb_array_length(add_question_version.body->'correct') < 1
    then
      raise exception 'mcq questions require at least 1 correct option';
    end if;
    if v_type = 'mcq_single' and jsonb_array_length(add_question_version.body->'correct') <> 1 then
      raise exception 'mcq_single requires exactly 1 correct option';
    end if;
  elsif v_type = 'true_false' then
    if jsonb_typeof(add_question_version.body->'correct') <> 'boolean' then
      raise exception 'true_false requires body.correct to be a boolean';
    end if;
  elsif v_type = 'numeric' then
    if nullif(add_question_version.body->>'correct', '') is null then
      raise exception 'numeric requires body.correct to be a number';
    end if;
    perform (add_question_version.body->>'correct')::numeric;
    if nullif(add_question_version.body->>'tolerance', '') is not null then
      perform (add_question_version.body->>'tolerance')::numeric;
    end if;
  elsif v_type = 'short_answer' then
    if add_question_version.body->'accepted' is null
      or jsonb_typeof(add_question_version.body->'accepted') <> 'array'
      or jsonb_array_length(add_question_version.body->'accepted') < 1
    then
      raise exception 'short_answer requires at least 1 accepted answer';
    end if;
  end if;

  select coalesce(max(qv.version_no), 0) + 1 into next_version_no
  from public.question_versions qv
  where qv.question_id = add_question_version.question_id;

  insert into public.question_versions (question_id, version_no, prompt, body, created_by)
  values (add_question_version.question_id, next_version_no, v_prompt, add_question_version.body, auth.uid())
  returning id into new_version_id;

  update public.questions
  set current_version_id = new_version_id
  where id = add_question_version.question_id;

  perform public.log_audit(
    'add_question_version',
    'question',
    add_question_version.question_id::text,
    jsonb_build_object('version_no', next_version_no)
  );

  return new_version_id;
end;
$$;

comment on function public.add_question_version(uuid, text, jsonb) is
  'This is how "editing" a question works: inserts version_no = max+1 (never mutates an existing version row — see question_versions_no_update trigger) and repoints questions.current_version_id. Old versions remain in the table forever, addressable by id, so past exam_attempts (Phase 3c/3d) that recorded a specific version_id stay auditable against the exact wording served. Owner-or-lecturer-or-higher only, re-derived via can_manage_question_bank(), same authority model as create_question — no EXECUTE lock-down needed.';

grant execute on function public.add_question_version(uuid, text, jsonb) to authenticated;

-- 9. set_question_status RPC — retire/reactivate -------------------------------

create or replace function public.set_question_status(
  question_id uuid,
  status text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_bank_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if set_question_status.status not in ('active', 'retired') then
    raise exception 'Unknown status %', set_question_status.status;
  end if;

  select bank_id into v_bank_id from public.questions where id = set_question_status.question_id;
  if v_bank_id is null then
    raise exception 'Question % not found', question_id;
  end if;

  if not public.can_manage_question_bank(v_bank_id) then
    raise exception 'Only the bank owner or a lecturer-or-higher may change this question''s status';
  end if;

  update public.questions
  set status = set_question_status.status
  where id = set_question_status.question_id;

  perform public.log_audit(
    'set_question_status',
    'question',
    set_question_status.question_id::text,
    jsonb_build_object('status', set_question_status.status)
  );
end;
$$;

comment on function public.set_question_status(uuid, text) is
  'Retires/reactivates a question (status only — content is untouched, so a retired question''s versions remain readable for any past exam_attempts referencing them). Owner-or-lecturer-or-higher only, re-derived via can_manage_question_bank().';

grant execute on function public.set_question_status(uuid, text) to authenticated;

-- 10. create_question_category RPC ---------------------------------------------

create or replace function public.create_question_category(
  bank_id uuid,
  name text,
  parent_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_id uuid;
  v_name text := trim(create_question_category.name);
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if not public.can_manage_question_bank(create_question_category.bank_id) then
    raise exception 'Only the bank owner or a lecturer-or-higher may add categories to this bank';
  end if;

  if v_name = '' then
    raise exception 'Category name is required';
  end if;

  if create_question_category.parent_id is not null then
    if not exists (
      select 1 from public.question_categories c
      where c.id = create_question_category.parent_id
        and c.bank_id = create_question_category.bank_id
    ) then
      raise exception 'Parent category % does not belong to bank %', parent_id, bank_id;
    end if;
  end if;

  insert into public.question_categories (bank_id, parent_id, name)
  values (create_question_category.bank_id, create_question_category.parent_id, v_name)
  returning id into new_id;

  perform public.log_audit(
    'create_question_category',
    'question_category',
    new_id::text,
    jsonb_build_object('bank_id', create_question_category.bank_id, 'name', v_name)
  );

  return new_id;
end;
$$;

comment on function public.create_question_category(uuid, text, uuid) is
  'Creates a category (optionally nested under parent_id, which must belong to the same bank). Owner-or-lecturer-or-higher only. Duplicate (bank_id, parent_id, name) is rejected by the unique constraint/index, surfaced to the caller as a Postgres unique_violation.';

grant execute on function public.create_question_category(uuid, text, uuid) to authenticated;

-- 11. rename_question_category RPC ---------------------------------------------

create or replace function public.rename_question_category(
  category_id uuid,
  name text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_bank_id uuid;
  v_name text := trim(rename_question_category.name);
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if v_name = '' then
    raise exception 'Category name is required';
  end if;

  select bank_id into v_bank_id
  from public.question_categories
  where id = rename_question_category.category_id;

  if v_bank_id is null then
    raise exception 'Category % not found', category_id;
  end if;

  if not public.can_manage_question_bank(v_bank_id) then
    raise exception 'Only the bank owner or a lecturer-or-higher may rename this category';
  end if;

  update public.question_categories
  set name = v_name
  where id = rename_question_category.category_id;

  perform public.log_audit(
    'rename_question_category',
    'question_category',
    rename_question_category.category_id::text,
    jsonb_build_object('name', v_name)
  );
end;
$$;

comment on function public.rename_question_category(uuid, text) is
  'Renames a category in place (categories are not versioned like question content — a name is metadata, not graded content). Owner-or-lecturer-or-higher only.';

grant execute on function public.rename_question_category(uuid, text) to authenticated;

-- 12. delete_question_category RPC ---------------------------------------------

create or replace function public.delete_question_category(
  category_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_bank_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select bank_id into v_bank_id
  from public.question_categories
  where id = delete_question_category.category_id;

  if v_bank_id is null then
    raise exception 'Category % not found', category_id;
  end if;

  if not public.can_manage_question_bank(v_bank_id) then
    raise exception 'Only the bank owner or a lecturer-or-higher may delete this category';
  end if;

  -- Cascades to child categories (on delete cascade) and sets
  -- questions.category_id to null for questions filed under it (on delete
  -- set null) — no data loss, questions just become "uncategorized".
  delete from public.question_categories where id = delete_question_category.category_id;

  perform public.log_audit(
    'delete_question_category',
    'question_category',
    delete_question_category.category_id::text,
    '{}'::jsonb
  );
end;
$$;

comment on function public.delete_question_category(uuid) is
  'Deletes a category. Child categories cascade-delete (on delete cascade); questions filed under it become uncategorized (category_id set null), never deleted. Owner-or-lecturer-or-higher only.';

grant execute on function public.delete_question_category(uuid) to authenticated;

-- 13. bank_question_summary RPC — list view with version content for the UI ---
-- The questions list/import-preview UI needs prompt + type + difficulty +
-- tags + status + category name in one call without exposing this as a
-- direct multi-table client join (RLS already allows the join via three
-- SELECT policies above, but a dedicated RPC keeps the shape stable and
-- avoids the client needing PostgREST embed syntax across four tables).
create or replace function public.bank_questions(bank_id uuid)
returns table (
  question_id uuid,
  type text,
  difficulty text,
  tags text[],
  status text,
  category_id uuid,
  category_name text,
  current_version_id uuid,
  version_no int,
  prompt text,
  body jsonb,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if not public.can_manage_question_bank(bank_questions.bank_id) then
    raise exception 'Only the bank owner or a lecturer-or-higher may view this bank''s questions';
  end if;

  return query
  select
    q.id as question_id,
    q.type,
    q.difficulty,
    q.tags,
    q.status,
    q.category_id,
    c.name as category_name,
    q.current_version_id,
    v.version_no,
    v.prompt,
    v.body,
    q.created_at,
    q.updated_at
  from public.questions q
  left join public.question_categories c on c.id = q.category_id
  left join public.question_versions v on v.id = q.current_version_id
  where q.bank_id = bank_questions.bank_id
  order by q.created_at desc;
end;
$$;

comment on function public.bank_questions(uuid) is
  'Owner-or-lecturer-or-higher question list for the authoring UI: one row per question with its CURRENT version''s prompt/body inlined and its category name resolved. Same authority check as every other RPC in this migration.';

grant execute on function public.bank_questions(uuid) to authenticated;
