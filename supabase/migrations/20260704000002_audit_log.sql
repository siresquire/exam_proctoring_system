-- Phase 0.2: append-only audit log.
-- Every privileged action across the platform writes here via
-- public.log_audit(). Enforcement is belt-and-braces: no UPDATE/DELETE
-- grants to any non-owner role, AND a trigger that raises on any attempt,
-- so a misconfigured grant alone can never make history mutable.

create table public.audit_log (
  id bigint generated always as identity primary key,
  actor_id uuid references auth.users (id),
  action text not null,
  target_type text,
  target_id text,
  metadata jsonb not null default '{}'::jsonb,
  ip inet,
  created_at timestamptz not null default now()
);

comment on table public.audit_log is
  'Append-only. INSERT only, via public.log_audit(). UPDATE/DELETE are revoked and additionally trapped by a trigger.';

-- Belt: revoke write privileges from the roles Supabase issues to clients.
-- (The table owner / migration role retains DDL rights, which is fine —
-- schema changes are not the threat model here, client mutation is.)
revoke update, delete on public.audit_log from anon, authenticated;

-- Braces: even a superuser-ish direct SQL UPDATE/DELETE through a
-- misconfigured grant is stopped dead.
create or replace function public.audit_log_immutable()
returns trigger
language plpgsql
as $$
begin
  raise exception 'audit_log is append-only: % is not permitted', tg_op;
end;
$$;

create trigger audit_log_no_update
  before update on public.audit_log
  for each row
  execute function public.audit_log_immutable();

create trigger audit_log_no_delete
  before delete on public.audit_log
  for each row
  execute function public.audit_log_immutable();
