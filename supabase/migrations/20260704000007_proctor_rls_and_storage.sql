-- Phase 1: RLS for proctor_sessions/proctor_events/proctor_media, plus the
-- 'proctoring' Supabase Storage bucket + its own RLS policies.
--
-- Policy matrix:
--
--   proctor_sessions / proctor_events / proctor_media:
--     SELECT  owner                      -- own rows (via session ownership
--                                           for events/media)
--     SELECT  lecturer_or_higher         -- ALL rows for now. Phase 4 scopes
--                                           this to "lecturer owns the exam
--                                           this session belongs to" once
--                                           exams/class ownership exist —
--                                           tracked there, not forgotten.
--     INSERT/UPDATE/DELETE  --            -- none for any client role; RPCs
--                                           (start/end_proctor_session,
--                                           log_proctor_events,
--                                           record_proctor_media) are the
--                                           only write path, same posture
--                                           as audit_log.
--
--   storage.objects (bucket 'proctoring', private):
--     INSERT  authenticated              -- only under {session_id}/... for
--                                           a session the caller owns AND
--                                           that is currently active
--     SELECT  owner or lecturer_or_higher

alter table public.proctor_sessions enable row level security;
alter table public.proctor_sessions force row level security;

alter table public.proctor_events enable row level security;
alter table public.proctor_events force row level security;

alter table public.proctor_media enable row level security;
alter table public.proctor_media force row level security;

-- proctor_sessions ----------------------------------------------------------

create policy proctor_sessions_select_own
  on public.proctor_sessions
  for select
  to authenticated
  using (user_id = auth.uid());

create policy proctor_sessions_select_lecturer_or_higher
  on public.proctor_sessions
  for select
  to authenticated
  using (public.has_role('lecturer'));

-- No INSERT/UPDATE/DELETE policies for any client role: writes only via
-- start_proctor_session / end_proctor_session (security definer, bypass
-- RLS on their own writes).

-- proctor_events --------------------------------------------------------

create policy proctor_events_select_own
  on public.proctor_events
  for select
  to authenticated
  using (
    exists (
      select 1 from public.proctor_sessions s
      where s.id = proctor_events.session_id and s.user_id = auth.uid()
    )
  );

create policy proctor_events_select_lecturer_or_higher
  on public.proctor_events
  for select
  to authenticated
  using (public.has_role('lecturer'));

-- No INSERT/UPDATE/DELETE policies: log_proctor_events() only (security
-- definer). UPDATE/DELETE are additionally revoked + trigger-trapped in
-- 20260704000006 (belt and braces, same as audit_log).

-- proctor_media -----------------------------------------------------------

create policy proctor_media_select_own
  on public.proctor_media
  for select
  to authenticated
  using (
    exists (
      select 1 from public.proctor_sessions s
      where s.id = proctor_media.session_id and s.user_id = auth.uid()
    )
  );

create policy proctor_media_select_lecturer_or_higher
  on public.proctor_media
  for select
  to authenticated
  using (public.has_role('lecturer'));

-- No INSERT/UPDATE/DELETE policies: record_proctor_media() only.

-- Storage: 'proctoring' bucket -------------------------------------------
-- LOCAL Supabase Storage for now. proctor-core's storage adapter interface
-- (packages/proctor-core/src/storage.ts) means swapping this for Cloudflare
-- R2 later touches only the apps/web adapter implementation, never the
-- engine — see that file's header comment and README.md "Proctoring engine
-- & demo" for the migration note.

insert into storage.buckets (id, name, public)
values ('proctoring', 'proctoring', false)
on conflict (id) do nothing;

-- INSERT: authenticated users may upload only under a path prefixed
-- '{session_id}/...' where {session_id} is a session they own AND that is
-- currently active. storage.objects.name is the full object key (bucket is
-- implicit via bucket_id), so we split on '/' to recover the session id
-- prefix and validate it against proctor_sessions.
create policy proctoring_insert_own_active_session
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'proctoring'
    and exists (
      select 1
      from public.proctor_sessions s
      where s.id::text = (storage.foldername(name))[1]
        and s.user_id = auth.uid()
        and s.status = 'active'
    )
  );

create policy proctoring_select_own
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'proctoring'
    and exists (
      select 1
      from public.proctor_sessions s
      where s.id::text = (storage.foldername(name))[1]
        and s.user_id = auth.uid()
    )
  );

create policy proctoring_select_lecturer_or_higher
  on storage.objects
  for select
  to authenticated
  using (bucket_id = 'proctoring' and public.has_role('lecturer'));

-- No UPDATE/DELETE policies on storage.objects for the 'proctoring' bucket:
-- proctoring media is append-only, same posture as the metadata tables.
