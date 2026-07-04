-- Phase 0.2: security-definer helper functions used by RLS policies and
-- application code. All are `set search_path = ''` and fully qualify
-- identifiers, per Supabase's documented RLS-function hardening guidance
-- (an attacker-controlled search_path is a classic definer-function
-- privilege escalation vector).

-- Reads the caller's own role. Security definer so it can read
-- public.profiles even for a role that itself has no SELECT policy on
-- other rows — this function IS the row lookup, not a bypass of it, since
-- it only ever returns the caller's own role.
create or replace function public.current_user_role()
returns public.user_role
language sql
stable
security definer
set search_path = ''
as $$
  select role from public.profiles where id = auth.uid();
$$;

comment on function public.current_user_role() is
  'Returns the calling user''s role from profiles. Used by RLS policies and app code.';

-- has_role: the standard role check for RLS policies. super_admin is a
-- UNIVERSAL role — it passes every has_role() check regardless of the
-- roles asked for, so every future table that gates access with
-- has_role('lecturer') (etc.) automatically includes super_admin without
-- anyone having to remember to add it to each policy.
create or replace function public.has_role(variadic roles public.user_role[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    public.current_user_role() = 'super_admin'
      or public.current_user_role() = any (roles),
    false
  );
$$;

comment on function public.has_role(variadic public.user_role[]) is
  'True when the caller holds any of the given roles. super_admin always passes (universal role).';

create or replace function public.is_admin_or_higher()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.has_role('admin');
$$;

comment on function public.is_admin_or_higher() is
  'True when the caller is admin or super_admin (via has_role''s universal super_admin pass-through).';

-- log_audit: the only sanctioned way to write to audit_log. Actor is
-- always derived from auth.uid() server-side, never trusted from the
-- caller, so a client cannot forge another user's actor_id.
create or replace function public.log_audit(
  action text,
  target_type text default null,
  target_id text default null,
  metadata jsonb default '{}'::jsonb
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_id bigint;
begin
  insert into public.audit_log (actor_id, action, target_type, target_id, metadata)
  values (auth.uid(), action, target_type, target_id, coalesce(metadata, '{}'::jsonb))
  returning id into new_id;

  return new_id;
end;
$$;

comment on function public.log_audit(text, text, text, jsonb) is
  'Append-only write path for audit_log. actor_id is always auth.uid(), never client-supplied. Not callable by clients — only from other security-definer functions or the service role, so a client cannot inject forged entries (e.g. a fake set_user_role action) into the integrity record.';

-- Clients must NOT be able to call this directly: otherwise any student
-- could pollute the audit trail with forged action strings/metadata via a
-- bare RPC call. Definer functions (e.g. set_user_role) still work — they
-- execute as the function owner, which retains EXECUTE — and trusted
-- server-side code uses the service role.
revoke execute on function public.log_audit(text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.log_audit(text, text, text, jsonb) to service_role;

-- set_user_role is defined in 20260704000005_rls_policies.sql, once the
-- profiles_guard_update trigger it needs to cooperate with exists — see
-- that file for the full escalation-rule implementation and rationale.
