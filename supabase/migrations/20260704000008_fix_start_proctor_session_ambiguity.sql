-- Phase 1 fix: start_proctor_session's plpgsql parameter `context` shadowed
-- (and was ambiguous against) proctor_sessions.context in the WHERE clause
-- of the concurrent-session lookup, even when qualified with the function
-- name — PostgreSQL's plpgsql parses `context` as the column reference
-- there regardless, per plpgsql's documented parameter/column resolution
-- order. Fix: copy parameters into local variables (`v_context`, `v_tier`)
-- so every reference inside the function body is unambiguous. The RPC's
-- external signature (parameter names `context`/`tier`, as called via
-- supabase.rpc('start_proctor_session', { context, tier })) is unchanged.

create or replace function public.start_proctor_session(context text, tier smallint default 2)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_context text := context;
  v_tier smallint := tier;
  new_id uuid;
  old_session record;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if v_context is null or length(trim(v_context)) = 0 then
    raise exception 'context is required';
  end if;

  if v_tier is null or v_tier < 1 or v_tier > 4 then
    raise exception 'tier must be between 1 and 4';
  end if;

  -- Concurrent-session detection: if a session is still active for this
  -- user+context, abandon it and log a flag on it rather than blocking the
  -- new session (a hostile client could always just not call
  -- end_proctor_session, so blocking would only punish honest reconnects —
  -- e.g. a crashed tab). The flag is what makes this a *detected* signal
  -- instead of a silent no-op.
  select s.id into old_session
  from public.proctor_sessions s
  where s.user_id = auth.uid() and s.context = v_context and s.status = 'active'
  for update;

  if old_session.id is not null then
    update public.proctor_sessions
    set status = 'abandoned', ended_at = now()
    where id = old_session.id;

    insert into public.proctor_events (session_id, event_type, severity, occurred_at, meta)
    values (
      old_session.id,
      'concurrent_session_detected',
      'high',
      now(),
      jsonb_build_object('reason', 'new_session_started_same_context')
    );
  end if;

  insert into public.proctor_sessions (user_id, context, integrity_tier, consent_given_at, user_agent, status)
  values (auth.uid(), v_context, v_tier, now(), current_setting('request.headers', true)::jsonb ->> 'user-agent', 'active')
  returning id into new_id;

  insert into public.proctor_events (session_id, event_type, severity, occurred_at, meta)
  values (new_id, 'session_start', 'info', now(), jsonb_build_object('tier', v_tier, 'context', v_context));

  return new_id;
end;
$$;

comment on function public.start_proctor_session(text, smallint) is
  'Creates a proctoring session for auth.uid(), records consent (consent_given_at = now()), abandons+flags any still-active session for the same user+context (concurrent-session detection), and logs session_start. Returns the new session id.';
