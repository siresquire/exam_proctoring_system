-- Phase 3a: classes, enrollment, and email-independent student onboarding.
--
-- Adds `classes` + `class_members` (the roster) and two `profiles` columns
-- that support onboarding without email delivery (PLAN.md "Student
-- onboarding without a domain"):
--   * must_change_password: set true whenever a student account is created
--     or its password is regenerated server-side (temp password), cleared
--     once the student sets their own password (see
--     apps/web/app/onboarding/set-password).
--   * phone: optional, for the SMS adapter (apps/web/lib/sms/).
--
-- Account CREATION itself (auth.users rows) is NOT done here — that's the
-- Auth admin API, server-side only (apps/web/lib/onboarding/). This
-- migration only adds the schema + RPCs that operate once an account
-- already exists: creating a class, enrolling an EXISTING student id into
-- it, and reading/removing membership.
--
-- Same security posture as every prior migration: RLS enabled + forced,
-- has_role()/is_admin_or_higher() for role checks (super_admin universal),
-- security-definer RPCs with `set search_path = ''`, and the
-- 20260705000006 lock-down pattern applied to any helper that trusts its
-- arguments rather than validating them independently.

-- 1. profiles additions -----------------------------------------------------

alter table public.profiles
  add column must_change_password boolean not null default false,
  add column phone text;

comment on column public.profiles.must_change_password is
  'Phase 3a: true for accounts created with a server-generated temp password (see apps/web/lib/onboarding), or whenever regenerate_temp_password() re-issues one. The dashboard layout (via lib/auth.ts requireRole) redirects a signed-in user with this flag set to /onboarding/set-password before anything else. Cleared by clear_must_change_password() once the user sets their own password.';
comment on column public.profiles.phone is
  'Optional phone number for the pluggable SMS adapter (apps/web/lib/sms/) — light validation only (no strict E.164 enforcement), since Ghana numbers are entered in varying local formats by lecturers doing CSV imports.';

-- must_change_password is registry-adjacent state, not free-text like
-- full_name: a student must not be able to clear it themselves (that would
-- let a compromised/never-rotated temp password stay "trusted" forever from
-- the app's point of view) and must not be able to set it true on someone
-- else. It is touched only by:
--   - the service-role account-creation/regenerate-temp-password path
--     (bypasses RLS entirely), and
--   - clear_must_change_password() below (security definer, self-only).
-- profiles_guard_update (20260704000005) already blocks a self-update from
-- touching anything other than full_name, and blocks a non-super-admin
-- admin-on-someone-else update from touching anything but accommodations —
-- so must_change_password and phone are ALREADY unreachable via a direct
-- client UPDATE for every role except super_admin. Extend the trigger so
-- super_admin's "any column" carve-out does not accidentally include
-- must_change_password either (it should only ever be set through the
-- service role or clear_must_change_password, never a hand-edited PATCH),
-- while still allowing phone to be edited by an admin (treated like
-- accommodations: contact info a lecturer/admin may need to correct).
create or replace function public.profiles_guard_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.role is distinct from old.role then
    if coalesce(current_setting('usted.allow_role_change', true), 'off') <> 'on' then
      raise exception 'role may only be changed via public.set_user_role()';
    end if;
  end if;

  if new.created_at is distinct from old.created_at then
    raise exception 'created_at cannot be changed';
  end if;

  -- must_change_password: only the service role (bypasses RLS/triggers
  -- entirely) or clear_must_change_password() (sets the same transaction-
  -- local GUC pattern as set_user_role) may change it. This applies even to
  -- super_admin, unlike every other column, because it is a security flag
  -- about which password is currently trusted, not ordinary profile data.
  if new.must_change_password is distinct from old.must_change_password then
    if coalesce(current_setting('usted.allow_password_flag_change', true), 'off') <> 'on' then
      raise exception 'must_change_password may only be changed via public.clear_must_change_password() or the service role';
    end if;
  end if;

  if public.current_user_role() = 'super_admin' then
    return new;
  end if;

  if auth.uid() = old.id then
    if new.student_number is distinct from old.student_number then
      raise exception 'student_number cannot be changed by the user themselves';
    end if;
    if new.accommodations is distinct from old.accommodations and not public.is_admin_or_higher() then
      raise exception 'accommodations can only be changed by an admin';
    end if;
  end if;

  if public.is_admin_or_higher() and auth.uid() is distinct from old.id then
    if new.full_name is distinct from old.full_name then
      raise exception 'full_name can only be changed by the profile owner';
    end if;
    if new.student_number is distinct from old.student_number then
      raise exception 'student_number cannot be changed via a direct update';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.profiles_guard_update() is
  'Phase 0.2 column-level UPDATE guard, extended in 20260705000008 to also protect must_change_password: it may only change via clear_must_change_password() (transaction-local usted.allow_password_flag_change GUC) or the service role, never a direct client PATCH — including by super_admin, since this flag gates which password is currently trusted.';

-- clear_must_change_password: the ONLY client-callable way to flip the flag
-- off, and only for the caller's own row. Used by
-- /onboarding/set-password after a successful supabase.auth.updateUser().
create or replace function public.clear_must_change_password()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  perform set_config('usted.allow_password_flag_change', 'on', true);
  update public.profiles set must_change_password = false where id = auth.uid();
  perform set_config('usted.allow_password_flag_change', 'off', true);
end;
$$;

comment on function public.clear_must_change_password() is
  'Clears must_change_password on the CALLER''s own profile. Called after the user successfully sets a new password via supabase.auth.updateUser() in /onboarding/set-password. Cannot target another user''s row (no id parameter) — self-only by construction.';

grant execute on function public.clear_must_change_password() to authenticated;

-- 2. classes -----------------------------------------------------------------

create table public.classes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  code text unique,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.classes is
  'Phase 3a: a lecturer- or admin-owned class/cohort. Enrollment lives in class_members. code is an optional short human-facing identifier (e.g. "CS201-A") — unique when set, null allowed for classes that do not need one.';
comment on column public.classes.code is
  'Optional short human class code, unique when set. Nullable because not every class needs one (e.g. a one-off cohort created purely for a single quiz).';

create index classes_owner_id_idx on public.classes (owner_id);

create trigger classes_set_updated_at
  before update on public.classes
  for each row
  execute function public.set_updated_at();

-- 3. class_members (the roster) ----------------------------------------------

create table public.class_members (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references public.classes (id) on delete cascade,
  student_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (class_id, student_id)
);

comment on table public.class_members is
  'Phase 3a: roster rows. One row per (class, student) enrollment — the unique constraint makes enroll_existing_student() naturally idempotent (upsert-shaped, no duplicate rows from re-importing the same CSV).';

create index class_members_class_id_idx on public.class_members (class_id);
create index class_members_student_id_idx on public.class_members (student_id);

-- 4. RLS ----------------------------------------------------------------------
-- Policy matrix:
--   classes:
--     SELECT  owner OR lecturer_or_higher   -- KNOWN SIMPLIFICATION, same as
--                                               forms_exams/proctor_* elsewhere
--                                               in this codebase: "any lecturer"
--                                               can see any class, not just
--                                               classes they teach. Phase 4
--                                               scopes this to ownership/
--                                               co-teaching once there is a
--                                               concept of shared classes.
--     INSERT/UPDATE/DELETE  owner OR lecturer_or_higher
--
--   class_members:
--     SELECT  owner-of-class OR lecturer_or_higher   -- any lecturer can see
--                                                        any roster (same
--                                                        simplification)
--     SELECT  student, own membership rows only      -- "classes I'm in"; a
--                                                        student must NOT see
--                                                        other students in the
--                                                        same class (roster
--                                                        privacy) — enforced by
--                                                        filtering on
--                                                        student_id = auth.uid(),
--                                                        not class_id, so a
--                                                        query for "everyone in
--                                                        class X" returns only
--                                                        the caller's own row.
--     INSERT/UPDATE/DELETE  --                          none directly; only via
--                                                        enroll_existing_student
--                                                        / remove_class_member
--                                                        RPCs below.

alter table public.classes enable row level security;
alter table public.classes force row level security;

alter table public.class_members enable row level security;
alter table public.class_members force row level security;

create policy classes_select_owner_or_lecturer
  on public.classes
  for select
  to authenticated
  using (owner_id = auth.uid() or public.has_role('lecturer'));

create policy classes_insert_owner_or_lecturer
  on public.classes
  for insert
  to authenticated
  with check (owner_id = auth.uid() and public.has_role('lecturer'));

create policy classes_update_owner_or_lecturer
  on public.classes
  for update
  to authenticated
  using (owner_id = auth.uid() or public.has_role('lecturer'))
  with check (owner_id = auth.uid() or public.has_role('lecturer'));

create policy classes_delete_owner_or_lecturer
  on public.classes
  for delete
  to authenticated
  using (owner_id = auth.uid() or public.has_role('lecturer'));

create policy class_members_select_owner_or_lecturer
  on public.class_members
  for select
  to authenticated
  using (
    public.has_role('lecturer')
    or exists (
      select 1 from public.classes c
      where c.id = class_members.class_id
        and c.owner_id = auth.uid()
    )
  );

-- A student may see their OWN enrollment rows (which classes they belong
-- to), never the rest of a class's roster — this is a second, additive
-- SELECT policy (PostgreSQL RLS policies OR together), scoped to
-- student_id = auth.uid() rather than class_id, so it never exposes other
-- students even when queried by class_id.
create policy class_members_select_own_membership
  on public.class_members
  for select
  to authenticated
  using (student_id = auth.uid());

-- No INSERT/UPDATE/DELETE policies for any client role on class_members:
-- membership changes only happen through enroll_existing_student() and
-- remove_class_member() below, both security definer.

-- 5. create_class RPC ----------------------------------------------------------

create or replace function public.create_class(
  name text,
  code text default null,
  description text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_id uuid;
  v_name text := trim(create_class.name);
  v_code text := nullif(trim(coalesce(create_class.code, '')), '');
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if not public.has_role('lecturer') then
    raise exception 'Only a lecturer, admin, or super_admin may create a class';
  end if;

  if v_name = '' then
    raise exception 'Class name is required';
  end if;

  insert into public.classes (owner_id, name, code, description)
  values (auth.uid(), v_name, v_code, create_class.description)
  returning id into new_id;

  perform public.log_audit(
    'create_class',
    'class',
    new_id::text,
    jsonb_build_object('name', v_name, 'code', v_code)
  );

  return new_id;
end;
$$;

comment on function public.create_class(text, text, text) is
  'Creates a class owned by the caller. Caller must be lecturer-or-higher (has_role(''lecturer'') — super_admin passes universally). Audit-logged. Runs as the function owner, so it may call the service-role-only log_audit() from inside this definer context (same pattern as set_user_role).';

grant execute on function public.create_class(text, text, text) to authenticated;

-- 6. enroll_existing_student RPC -----------------------------------------------
-- Enrolls an ALREADY-EXISTING auth user (looked up by the caller, typically
-- via profiles.student_number, before calling this) into a class the caller
-- owns or can manage. Idempotent: re-enrolling an already-enrolled student
-- is a no-op, not an error, so a lecturer can re-run a CSV import safely.

create or replace function public.enroll_existing_student(
  class_id uuid,
  student_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
  v_student_role public.user_role;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select owner_id into v_owner from public.classes where id = enroll_existing_student.class_id;
  if v_owner is null then
    raise exception 'Class % not found', class_id;
  end if;

  if v_owner <> auth.uid() and not public.has_role('lecturer') then
    raise exception 'Only the class owner or a lecturer may enroll students';
  end if;

  select role into v_student_role from public.profiles where id = enroll_existing_student.student_id;
  if v_student_role is null then
    raise exception 'Target user % has no profile', student_id;
  end if;
  if v_student_role <> 'student' then
    raise exception 'Target user % is not a student (role=%)', student_id, v_student_role;
  end if;

  insert into public.class_members (class_id, student_id)
  values (enroll_existing_student.class_id, enroll_existing_student.student_id)
  on conflict (class_id, student_id) do nothing;

  perform public.log_audit(
    'enroll_student',
    'class',
    class_id::text,
    jsonb_build_object('student_id', student_id)
  );
end;
$$;

comment on function public.enroll_existing_student(uuid, uuid) is
  'Upserts a class_members row for an existing student account. Owner-or-lecturer-or-higher only (same ownership check as classes RLS). No-op (ON CONFLICT DO NOTHING) if already enrolled, so CSV re-imports are safe to re-run. Rejects targets whose profile role is not ''student''. Audit-logged.';

grant execute on function public.enroll_existing_student(uuid, uuid) to authenticated;

-- 7. remove_class_member RPC ---------------------------------------------------

create or replace function public.remove_class_member(
  class_id uuid,
  student_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select owner_id into v_owner from public.classes where id = remove_class_member.class_id;
  if v_owner is null then
    raise exception 'Class % not found', class_id;
  end if;

  if v_owner <> auth.uid() and not public.has_role('lecturer') then
    raise exception 'Only the class owner or a lecturer may remove a student from this class';
  end if;

  delete from public.class_members
  where class_id = remove_class_member.class_id
    and student_id = remove_class_member.student_id;

  perform public.log_audit(
    'remove_class_member',
    'class',
    class_id::text,
    jsonb_build_object('student_id', student_id)
  );
end;
$$;

comment on function public.remove_class_member(uuid, uuid) is
  'Removes a student from a class roster. Owner-or-lecturer-or-higher only. No-op if the student was not enrolled. Audit-logged.';

grant execute on function public.remove_class_member(uuid, uuid) to authenticated;

-- 8. class_roster RPC — lecturer/owner roster view with student names -------
-- A security-definer RPC (rather than relying on the client to join
-- class_members -> profiles itself) because profiles has no general
-- lecturer-can-read-any-student-row SELECT policy beyond
-- profiles_select_admin_or_higher — a plain lecturer (not admin) could
-- enroll students but not otherwise read their full_name/student_number via
-- a client-side join. This mirrors forms_exam_sessions' shape.
create or replace function public.class_roster(class_id uuid)
returns table (
  student_id uuid,
  full_name text,
  student_number text,
  phone text,
  enrolled_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select owner_id into v_owner from public.classes where id = class_roster.class_id;
  if v_owner is null then
    raise exception 'Class % not found', class_id;
  end if;

  if v_owner <> auth.uid() and not public.has_role('lecturer') then
    raise exception 'Only the class owner or a lecturer may view this roster';
  end if;

  return query
  select
    p.id as student_id,
    p.full_name,
    p.student_number,
    p.phone,
    cm.created_at as enrolled_at
  from public.class_members cm
  join public.profiles p on p.id = cm.student_id
  where cm.class_id = class_roster.class_id
  order by p.full_name nulls last, p.student_number nulls last;
end;
$$;

comment on function public.class_roster(uuid) is
  'Owner-or-lecturer-or-higher roster view: one row per enrolled student with full_name/student_number/phone, for the class dashboard, roster export, and SMS send flow. Same ownership check as enroll_existing_student/remove_class_member.';

grant execute on function public.class_roster(uuid) to authenticated;
