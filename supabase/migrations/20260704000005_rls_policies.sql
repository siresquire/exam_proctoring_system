-- Phase 0.2: Row Level Security. Enabled AND forced on every table (force
-- means even the table owner is subject to RLS over PostgREST — belt and
-- braces alongside the explicit policies below).
--
-- Policy matrix (table x role x operation):
--
--   profiles:
--     SELECT  self                       -- own row
--     SELECT  admin_or_higher            -- all rows
--     UPDATE  self                       -- own row, full_name only (enforced
--                                           by trigger; role/student_number/
--                                           accommodations are rejected)
--     UPDATE  admin                      -- accommodations column only, any
--                                           row (role changes still go
--                                           through set_user_role, not a
--                                           direct UPDATE policy)
--     UPDATE  super_admin                -- any column except role, any row
--                                           (universal role; role still only
--                                           via set_user_role)
--     INSERT  --                          -- none (handle_new_user trigger only)
--     DELETE  --                          -- none
--
--   super_admin is a UNIVERSAL role: every capability any other role has,
--   super_admin has too — enforced structurally by public.has_role(),
--   which always passes for super_admin, so future tables inherit the
--   behavior instead of listing super_admin per policy. The only rules
--   that still bind super_admin: nobody may change their own role, and
--   role changes only happen through set_user_role.
--
--   audit_log:
--     SELECT  admin_or_higher            -- all rows
--     INSERT  --                          -- none directly (log_audit() only,
--                                           runs as security definer)
--     UPDATE/DELETE -- none (see 20260704000002_audit_log.sql)
--
--   keepalive:
--     SELECT  anon, authenticated        -- the cron ping
--     INSERT/UPDATE/DELETE -- none (service role bypasses RLS entirely for
--                                     any future maintenance ping-refresh)

alter table public.profiles enable row level security;
alter table public.profiles force row level security;

alter table public.audit_log enable row level security;
alter table public.audit_log force row level security;

alter table public.keepalive enable row level security;
alter table public.keepalive force row level security;

-- profiles ----------------------------------------------------------------

create policy profiles_select_own
  on public.profiles
  for select
  to authenticated
  using (id = auth.uid());

create policy profiles_select_admin_or_higher
  on public.profiles
  for select
  to authenticated
  using (public.is_admin_or_higher());

-- Self-update: allowed at the RLS layer for any column (RLS can't express
-- "this column only"), but a BEFORE UPDATE trigger below rejects the
-- statement outright if a non-admin caller changes anything other than
-- full_name. This is the "column-level check comparing OLD/NEW" called for
-- in the task brief.
create policy profiles_update_own
  on public.profiles
  for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- Admin/super_admin may update any row (used to edit accommodations); the
-- same trigger restricts non-role columns they may touch to accommodations
-- only, since role changes must go through set_user_role's escalation
-- rules instead of a direct UPDATE.
create policy profiles_update_admin_or_higher
  on public.profiles
  for update
  to authenticated
  using (public.is_admin_or_higher())
  with check (public.is_admin_or_higher());

-- No INSERT/DELETE policies for any client role: rows are created only by
-- the handle_new_user trigger (security definer, bypasses RLS) and never
-- deleted directly (they cascade from auth.users deletion instead).

create or replace function public.profiles_guard_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Triggers fire regardless of which security-definer function performed
  -- the UPDATE, so we can't tell "this update came from set_user_role" by
  -- inspecting the call stack. Instead, set_user_role sets a
  -- transaction-local GUC (usted.allow_role_change = 'on') immediately
  -- around its own UPDATE and clears it right after. Any role change made
  -- without that flag set — i.e. every direct UPDATE from PostgREST/the
  -- client — is rejected here.
  if new.role is distinct from old.role then
    if coalesce(current_setting('usted.allow_role_change', true), 'off') <> 'on' then
      raise exception 'role may only be changed via public.set_user_role()';
    end if;
  end if;

  -- created_at is registry metadata: once profile rows become evidence
  -- (audit trails, enrollment disputes), backdating must be impossible for
  -- everyone — including super_admin.
  if new.created_at is distinct from old.created_at then
    raise exception 'created_at cannot be changed';
  end if;

  -- super_admin is universal: any column except role and created_at
  -- (guarded above) may be updated on any row. Everyone else falls through
  -- to the column-level checks below.
  if public.current_user_role() = 'super_admin' then
    return new;
  end if;

  if auth.uid() = old.id then
    -- Self-update path: full_name may change; student_number never may
    -- (it is registry data, set by the service role at import time);
    -- accommodations only if the caller is an admin (admins may edit any
    -- profile's accommodations, including — trivially — their own).
    if new.student_number is distinct from old.student_number then
      raise exception 'student_number cannot be changed by the user themselves';
    end if;
    if new.accommodations is distinct from old.accommodations and not public.is_admin_or_higher() then
      raise exception 'accommodations can only be changed by an admin';
    end if;
  end if;

  if public.is_admin_or_higher() and auth.uid() is distinct from old.id then
    -- Admin-on-someone-else path: only accommodations may change (role
    -- changes must go through set_user_role).
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

create trigger profiles_guard_update_trigger
  before update on public.profiles
  for each row
  execute function public.profiles_guard_update();

-- set_user_role: the only sanctioned way to change a profile's role.
-- Escalation rules (enforced here, not in the client):
--   * Nobody may change their own role.
--   * Only super_admin may grant or revoke admin / super_admin.
--   * admin may only set lecturer / student.
--   * lecturer/student callers may not call this at all.
-- It flips the usted.allow_role_change GUC (transaction-local, via
-- set_config(..., true)) around its own UPDATE so profiles_guard_update
-- permits that one specific role change; every outcome is audit-logged.
create function public.set_user_role(target uuid, new_role public.user_role)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_role public.user_role;
  target_old_role public.user_role;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if target = auth.uid() then
    raise exception 'You may not change your own role';
  end if;

  caller_role := public.current_user_role();

  select role into target_old_role from public.profiles where id = target;
  if target_old_role is null then
    raise exception 'Target user % has no profile', target;
  end if;

  if caller_role = 'super_admin' then
    null;
  elsif caller_role = 'admin' then
    if new_role in ('admin', 'super_admin') or target_old_role in ('admin', 'super_admin') then
      raise exception 'Only super_admin may grant or revoke admin/super_admin roles';
    end if;
    if new_role not in ('lecturer', 'student') then
      raise exception 'admin may only set the lecturer or student role';
    end if;
  else
    raise exception 'Only admin or super_admin may change roles';
  end if;

  perform set_config('usted.allow_role_change', 'on', true);
  update public.profiles set role = new_role where id = target;
  perform set_config('usted.allow_role_change', 'off', true);

  perform public.log_audit(
    'set_user_role',
    'profile',
    target::text,
    jsonb_build_object('old_role', target_old_role, 'new_role', new_role)
  );
end;
$$;

comment on function public.set_user_role(uuid, public.user_role) is
  'Sanctioned role-change RPC. Enforces escalation rules server-side and audit-logs every change. Flips usted.allow_role_change so profiles_guard_update permits its own UPDATE.';

grant execute on function public.set_user_role(uuid, public.user_role) to authenticated;

-- audit_log -----------------------------------------------------------------

create policy audit_log_select_admin_or_higher
  on public.audit_log
  for select
  to authenticated
  using (public.is_admin_or_higher());

-- Deliberately no INSERT policy for authenticated/anon: the only insert
-- path is public.log_audit(), a security-definer function that bypasses
-- RLS on its own insert. No UPDATE/DELETE policies either (see
-- 20260704000002_audit_log.sql for the revoke + trigger belt-and-braces).

-- keepalive -------------------------------------------------------------

create policy keepalive_select_anyone
  on public.keepalive
  for select
  to anon, authenticated
  using (true);

-- No INSERT/UPDATE/DELETE policies: the cron only SELECTs. Any future
-- ping-refresh write goes through the service role, which bypasses RLS
-- entirely and needs no policy here.
