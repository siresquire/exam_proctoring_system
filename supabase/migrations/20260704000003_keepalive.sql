-- Phase 0.2: keep-alive table.
-- Single-row table the GitHub Actions cron SELECTs to keep the free-tier
-- Supabase project out of the 7-day idle pause (PLAN.md §1, §6).

create table public.keepalive (
  id int primary key,
  pinged_at timestamptz not null default now()
);

comment on table public.keepalive is
  'Single row, read by the keepalive GitHub Action cron. No client writes — only the cron''s SELECT matters.';

insert into public.keepalive (id, pinged_at) values (1, now());
