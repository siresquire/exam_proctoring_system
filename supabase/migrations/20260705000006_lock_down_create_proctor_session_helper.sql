-- Phase 2a security fix: lock down the internal _create_proctor_session helper.
--
-- 20260705000005 introduced public._create_proctor_session as a SHARED helper
-- for start_proctor_session (validates + merges a caller policy) and
-- start_forms_exam_session (uses the EXAM's stored policy). The helper itself
-- does NO policy validation — it trusts whatever policy/tier it is handed,
-- because its only intended callers are those two security-definer functions,
-- which produce a trusted policy first.
--
-- The bug: that migration relied on a leading-underscore NAMING convention +
-- "we didn't GRANT it" for protection — but Postgres grants EXECUTE to PUBLIC
-- by default on new functions, and Supabase additionally grants EXECUTE to
-- `anon`/`authenticated` on public-schema functions. So the helper was in fact
-- directly callable over PostgREST (`/rest/v1/rpc/_create_proctor_session`) by
-- any signed-in user. Verified empirically: a student called it directly with
-- an all-`counts:false` policy and got a live session id back — completely
-- bypassing start_forms_exam_session's exam-owned-policy guarantee (they could
-- mint a session that never hits the violation limit).
--
-- Fix: revoke EXECUTE from PUBLIC/anon/authenticated. The two security-definer
-- callers are UNAFFECTED — they execute as the function owner (postgres), which
-- retains its own EXECUTE grant (postgres=X/postgres in the ACL). This is the
-- correct trust boundary: the helper is reachable only THROUGH the validating
-- entry points, never directly by a client.
--
-- Applies to the exact 5-arg signature created in 20260705000005.

revoke execute on function public._create_proctor_session(text, smallint, jsonb, text, boolean)
  from public, anon, authenticated;

comment on function public._create_proctor_session(text, smallint, jsonb, text, boolean) is
  'INTERNAL helper — EXECUTE revoked from public/anon/authenticated (20260705000006). Callable only by the security-definer entry points start_proctor_session and start_forms_exam_session, which run as the owner and produce a validated/trusted policy before delegating here. This function trusts its policy/tier arguments and does NO validation, so it must never be directly client-reachable. Do not GRANT it to client roles.';
