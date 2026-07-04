-- Phase 0.2: four-role auth foundation.
-- Creates the `user_role` enum and the `profiles` table that mirrors
-- auth.users 1:1, auto-populated by a trigger on signup.

create type public.user_role as enum ('super_admin', 'admin', 'lecturer', 'student');

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  role public.user_role not null default 'student',
  full_name text,
  student_number text unique,
  -- Accommodations (DESIGN.md §3 "Operable" / "Proctoring-specific
  -- accessibility"). Documented keys — enforced in application code, kept
  -- as jsonb because the shape will grow as accommodation types are added:
  --   extra_time_multiplier: numeric   -- e.g. 1.25, 1.5, 2 (DESIGN.md 2.2.1)
  --   suppress_at_flags:     boolean   -- suppress/annotate AT-triggered
  --                                       blur/focus proctoring flags
  --   notes:                 text      -- free-text context for reviewers
  accommodations jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is
  'One row per auth.users row (1:1, same id). Role + accommodations drive RLS across the platform.';
comment on column public.profiles.accommodations is
  'Documented keys: extra_time_multiplier (numeric), suppress_at_flags (boolean), notes (text). See table comment.';

-- updated_at trigger -----------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row
  execute function public.set_updated_at();

-- Auto-create profile row on signup --------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, new.raw_user_meta_data ->> 'full_name');
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();
