-- Phase 4: account lifecycle management — suspend/reactivate, soft-remove,
-- and (super_admin only) permanent delete — with a role-scoped permission
-- matrix enforced in Postgres, mirroring set_user_role's escalation rules
-- (supabase/migrations/20260704000005_rls_policies.sql).
--
-- Semantics (owner's decisions):
--   profiles.status: 'active' | 'suspended' | 'removed'.
--     active    = normal.
--     suspended = reversible disable (active <-> suspended).
--     removed   = SOFT delete: archived, blocked, but records kept —
--                 reversible by restoring to 'active'.
--   Permanent delete (hard-deletes the auth.users row + cascades) is NOT
--   done in SQL here — auth.users deletion only happens via the Admin API
--   in a server action (apps/web/app/dashboard/users/actions.ts), which
--   audit-logs it via log_audit BEFORE calling admin.auth.admin.deleteUser.
--
-- Permission matrix (who may change whose status), enforced entirely
-- inside set_account_status below — never trust the client for any of
-- this:
--   super_admin -> admin, lecturer, student (NOT super_admin, NOT self)
--   admin       -> lecturer, student          (NOT admin/super_admin, NOT self)
--   lecturer    -> student ONLY, and ONLY a student enrolled in a class the
--                  lecturer OWNS (classes.owner_id = auth.uid())  (NOT self)
--   nobody acts on themselves or on an equal/higher role.

-- 1. profiles.status ----------------------------------------------------------

alter table public.profiles
  add column status text not null default 'active'
    check (status in ('active', 'suspended', 'removed'));

comment on column public.profiles.status is
  'Phase 4 account lifecycle: active (normal) | suspended (reversible disable) | removed (soft delete — archived, blocked, records kept, reversible by restoring to active). Changed ONLY via public.set_account_status() — see profiles_guard_update''s usted.allow_status_change GUC gate below, which blocks a direct client PATCH even for super_admin, the same pattern already used for role/must_change_password.';

-- 2. profiles_guard_update: gate status the same way role/must_change_password
--    are gated ----------------------------------------------------------------
-- Without this, a direct client UPDATE of profiles.status would slip through
-- untouched by every existing branch of this trigger (none of them mention
-- status), which would be a serious hole: RLS's profiles_update_own policy
-- lets a user UPDATE their OWN row on any column the trigger doesn't
-- restrict — so a suspended user with a still-valid JWT could simply PATCH
-- their own status back to 'active' via a direct PostgREST call, bypassing
-- set_account_status' matrix entirely. Gating status behind a
-- transaction-local GUC (usted.allow_status_change), flipped only by
-- set_account_status around its own UPDATE, closes that hole exactly like
-- usted.allow_role_change does for role — checked BEFORE the
-- `current_user_role() = 'super_admin' -> return new` early-out, so even
-- super_admin cannot direct-PATCH status, only via the RPC (same posture as
-- must_change_password).
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

  if new.status is distinct from old.status then
    if coalesce(current_setting('usted.allow_status_change', true), 'off') <> 'on' then
      raise exception 'status may only be changed via public.set_account_status()';
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
  'Phase 0.2 column-level UPDATE guard (role/created_at), extended in 20260705000008/9 for must_change_password, and in 20260711000001 for status: status may only change via public.set_account_status(), gated by the transaction-local usted.allow_status_change GUC exactly like usted.allow_role_change gates role — checked before the super_admin passthrough, so not even super_admin may direct-PATCH status.';

-- 3. set_account_status: the only sanctioned way to change a profile's
--    lifecycle status --------------------------------------------------------
create or replace function public.set_account_status(target_user_id uuid, new_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_role public.user_role;
  target_role public.user_role;
  old_status text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if new_status not in ('active', 'suspended', 'removed') then
    raise exception 'Invalid status %, must be active, suspended, or removed', new_status;
  end if;

  if target_user_id = auth.uid() then
    raise exception 'You may not change your own account status';
  end if;

  caller_role := public.current_user_role();

  select p.role, p.status into target_role, old_status
  from public.profiles p
  where p.id = set_account_status.target_user_id;

  if target_role is null then
    raise exception 'Target user % has no profile', target_user_id;
  end if;

  if caller_role = 'super_admin' then
    -- super_admin may act on admin, lecturer, student — never another
    -- super_admin (nobody acts on an equal-or-higher role).
    if target_role = 'super_admin' then
      raise exception 'Nobody may change a super_admin account''s status';
    end if;
  elsif caller_role = 'admin' then
    -- admin may act on lecturer, student only.
    if target_role not in ('lecturer', 'student') then
      raise exception 'admin may only change the status of a lecturer or student account';
    end if;
  elsif caller_role = 'lecturer' then
    -- lecturer may act ONLY on a student enrolled in a class the lecturer
    -- owns. Ownership + enrollment are re-derived here from auth.uid(),
    -- never trusted from the caller.
    if target_role <> 'student' then
      raise exception 'lecturer may only change the status of a student account';
    end if;
    if not exists (
      select 1
      from public.classes c
      join public.class_members cm on cm.class_id = c.id
      where c.owner_id = auth.uid()
        and cm.student_id = set_account_status.target_user_id
    ) then
      raise exception 'lecturer may only change the status of a student enrolled in a class they own';
    end if;
  else
    raise exception 'Only lecturer, admin, or super_admin may change an account''s status';
  end if;

  perform set_config('usted.allow_status_change', 'on', true);
  update public.profiles set status = new_status where id = target_user_id;
  perform set_config('usted.allow_status_change', 'off', true);

  perform public.log_audit(
    'set_account_status',
    'profile',
    target_user_id::text,
    jsonb_build_object('old_status', old_status, 'new_status', new_status)
  );
end;
$$;

comment on function public.set_account_status(uuid, text) is
  'Sanctioned account-lifecycle RPC. Re-derives the caller''s authority from auth.uid() every call (safe to grant broadly to authenticated — no lock-down needed): super_admin -> admin/lecturer/student; admin -> lecturer/student; lecturer -> student ONLY if enrolled in a class the lecturer owns (classes.owner_id = auth.uid()). Nobody may target themselves or an equal/higher role. Flips usted.allow_status_change so profiles_guard_update permits its own UPDATE. Audit-logged with {old_status, new_status}. Permanent (hard) delete is deliberately NOT here — see apps/web/app/dashboard/users/actions.ts#permanentlyDeleteAccount, super_admin-only, via the Admin API.';

grant execute on function public.set_account_status(uuid, text) to authenticated;

-- 4. class_roster: surface status so the lecturer/admin roster UI can show
--    each student's current lifecycle state and decide which action
--    (suspend/reactivate/remove) to offer -----------------------------------
-- CREATE OR REPLACE cannot change a function's OUT-parameter row shape
-- (adding the new `status` column), so the old signature must be dropped
-- first — same effective signature (class_id uuid) otherwise.
drop function if exists public.class_roster(uuid);

create function public.class_roster(class_id uuid)
returns table (
  student_id uuid,
  full_name text,
  student_number text,
  phone text,
  status text,
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

  select c.owner_id into v_owner from public.classes c where c.id = class_roster.class_id;
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
    p.status,
    cm.created_at as enrolled_at
  from public.class_members cm
  join public.profiles p on p.id = cm.student_id
  where cm.class_id = class_roster.class_id
  order by p.full_name nulls last, p.student_number nulls last;
end;
$$;

comment on function public.class_roster(uuid) is
  'Owner-or-lecturer-or-higher roster view: one row per enrolled student with full_name/student_number/phone/status, for the class dashboard, roster export, SMS send flow, and (20260711000001) the account-lifecycle actions menu. Same ownership check as enroll_existing_student/remove_class_member.';

grant execute on function public.class_roster(uuid) to authenticated;
