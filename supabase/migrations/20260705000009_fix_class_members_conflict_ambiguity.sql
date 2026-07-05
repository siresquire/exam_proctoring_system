-- Phase 3a bugfix: enroll_existing_student and remove_class_member both hit
-- `column reference "class_id" is ambiguous` at runtime (found by the
-- extended RLS smoke test's q6/q9 checks). Root cause: plpgsql resolves a
-- BARE column reference against BOTH the function's parameters and the
-- query's table columns when they share a name, and errors instead of
-- guessing — this bites in two different spots:
--
--   1. `on conflict (class_id, student_id)` in enroll_existing_student: the
--      ON CONFLICT target list cannot be schema/table-qualified at all
--      (`on conflict (class_members.class_id, ...)` is a syntax error), so
--      as long as the function parameters are named class_id/student_id,
--      any column-list conflict target is inherently ambiguous. Fixed by
--      referencing the unique constraint by name instead:
--      `on conflict on constraint class_members_class_id_student_id_key`.
--
--   2. `where class_id = enroll_existing_student.class_id` /
--      `where class_id = remove_class_member.class_id` in both functions:
--      only the RIGHT-hand side was qualified with the function name; the
--      LEFT-hand bare `class_id` (meant to be the class_members column) is
--      still ambiguous against the parameter of the same name. Fixed by
--      aliasing the table (`class_members cm`) and qualifying every column
--      reference against that alias instead of leaving any side bare.
--
-- External signatures/behavior are otherwise unchanged; CREATE OR REPLACE
-- is sufficient (same parameter names, same return type).

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

  select c.owner_id into v_owner from public.classes c where c.id = enroll_existing_student.class_id;
  if v_owner is null then
    raise exception 'Class % not found', class_id;
  end if;

  if v_owner <> auth.uid() and not public.has_role('lecturer') then
    raise exception 'Only the class owner or a lecturer may enroll students';
  end if;

  select p.role into v_student_role from public.profiles p where p.id = enroll_existing_student.student_id;
  if v_student_role is null then
    raise exception 'Target user % has no profile', student_id;
  end if;
  if v_student_role <> 'student' then
    raise exception 'Target user % is not a student (role=%)', student_id, v_student_role;
  end if;

  insert into public.class_members (class_id, student_id)
  values (enroll_existing_student.class_id, enroll_existing_student.student_id)
  on conflict on constraint class_members_class_id_student_id_key do nothing;

  perform public.log_audit(
    'enroll_student',
    'class',
    class_id::text,
    jsonb_build_object('student_id', student_id)
  );
end;
$$;

comment on function public.enroll_existing_student(uuid, uuid) is
  'Upserts a class_members row for an existing student account. Owner-or-lecturer-or-higher only (same ownership check as classes RLS). No-op (ON CONFLICT ON CONSTRAINT ... DO NOTHING) if already enrolled, so CSV re-imports are safe to re-run. Rejects targets whose profile role is not ''student''. Audit-logged. 20260705000009: fixed a column-reference-is-ambiguous bug (conflict target list + bare WHERE-clause columns colliding with this function''s identically-named parameters) by using a named constraint for the conflict target and table aliases for every lookup.';

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

  select c.owner_id into v_owner from public.classes c where c.id = remove_class_member.class_id;
  if v_owner is null then
    raise exception 'Class % not found', class_id;
  end if;

  if v_owner <> auth.uid() and not public.has_role('lecturer') then
    raise exception 'Only the class owner or a lecturer may remove a student from this class';
  end if;

  delete from public.class_members cm
  where cm.class_id = remove_class_member.class_id
    and cm.student_id = remove_class_member.student_id;

  perform public.log_audit(
    'remove_class_member',
    'class',
    class_id::text,
    jsonb_build_object('student_id', student_id)
  );
end;
$$;

comment on function public.remove_class_member(uuid, uuid) is
  'Removes a student from a class roster. Owner-or-lecturer-or-higher only. No-op if the student was not enrolled. Audit-logged. 20260705000009: fixed the same column-reference-is-ambiguous bug as enroll_existing_student by qualifying every class_members column reference with a table alias.';

-- Second bugfix in this migration (found by the same smoke-test run, q12b):
-- profiles_guard_update's must_change_password guard (20260705000008) reads
-- "the service role bypasses RLS entirely" too literally. `rolbypassrls`
-- (true for service_role) only skips ROW LEVEL SECURITY POLICIES — it does
-- NOT disable BEFORE UPDATE TRIGGERS, which still fire unconditionally for
-- every role including service_role. So the trigger's GUC check rejected
-- even apps/web/lib/onboarding/create-student.ts's service-role profile
-- update (`.update({ ..., must_change_password: true })`), which is
-- supposed to be one of the two sanctioned writers per the column comment.
--
-- The natural first fix attempt — checking `current_user`/`session_user`
-- inside the trigger — does NOT work here and was verified empirically to
-- fail: this function is `security definer`, so `current_user` inside its
-- body is always the function OWNER (postgres), never the caller. And
-- `session_user` is always `authenticator` for every PostgREST-mediated
-- call (service-role AND authenticated alike) because PostgREST connects
-- once as `authenticator` and does `SET LOCAL ROLE <target>` per request,
-- which does not change `session_user`. Neither distinguishes the two.
--
-- What DOES distinguish them (verified empirically the same way): the
-- request's own JWT `role` claim, available via
-- `current_setting('request.jwt.claims', true)::jsonb ->> 'role'` —
-- `'service_role'` for the service-role key, `'authenticated'` for a real
-- user session. This is the same `current_setting(...)::jsonb` technique
-- `_create_proctor_session` already uses for `request.headers` — reading a
-- PostgREST-populated GUC, not a client-supplied value a caller could spoof
-- (it is derived server-side from the API key/JWT actually presented).
create or replace function public.profiles_guard_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_jwt_role text := current_setting('request.jwt.claims', true)::jsonb ->> 'role';
begin
  if new.role is distinct from old.role then
    if coalesce(current_setting('usted.allow_role_change', true), 'off') <> 'on' then
      raise exception 'role may only be changed via public.set_user_role()';
    end if;
  end if;

  if new.created_at is distinct from old.created_at then
    raise exception 'created_at cannot be changed';
  end if;

  if new.must_change_password is distinct from old.must_change_password then
    if v_jwt_role is distinct from 'service_role'
       and coalesce(current_setting('usted.allow_password_flag_change', true), 'off') <> 'on' then
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
  'Phase 0.2 column-level UPDATE guard. 20260705000008 added the must_change_password protection; 20260705000009 fixed it to also recognize the service role via the request''s JWT role claim (request.jwt.claims ->> ''role'' = ''service_role''), NOT current_user/session_user — both are unusable here: this function is security definer so current_user is always the owner (postgres), and session_user is always ''authenticator'' for every PostgREST call regardless of which key was used. apps/web/lib/onboarding/create-student.ts sets this column via the service-role client as one of its two sanctioned writers.';
