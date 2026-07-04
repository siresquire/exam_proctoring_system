-- LOCAL DEV ONLY. This file is applied automatically by `supabase db reset`
-- against your local Postgres (see supabase/config.toml [db.seed]). It is
-- NOT applied by `supabase db push` to a hosted project.
--
-- Purpose: promote the first user you create (via Supabase Studio's Auth
-- panel, or by signing up through the app) to super_admin, so there is at
-- least one account that can grant roles to everyone else.
--
-- HOW TO USE:
--   1. Sign up (or create a user in Studio) with the email you want as the
--      platform's first super_admin.
--   2. Replace the placeholder email below with that real email.
--   3. Run `supabase db reset` (local) — or run the equivalent block by
--      hand in the SQL editor of your hosted project (see README.md
--      "Supabase setup" for the hosted equivalent; seed.sql itself never
--      runs against a hosted project).
--
-- WHY THE TRANSACTION-LOCAL GUC: a plain `update ... set role = ...` is
-- rejected by the profiles_guard_update trigger (see
-- supabase/migrations/20260704000005_rls_policies.sql) — role changes are
-- normally only permitted through public.set_user_role(), which needs
-- auth.uid() and therefore cannot be called from a bootstrap script running
-- as postgres with no authenticated session. Setting
-- usted.allow_role_change = 'on' for the duration of this transaction (via
-- `set local`, so it never leaks past `commit`) is the documented escape
-- hatch for exactly this situation: seeding the very first super_admin
-- before any account exists that could call set_user_role. Every role
-- change after this one must go through set_user_role.

begin;
set local usted.allow_role_change = 'on';

update public.profiles
set role = 'super_admin'
where id = (select id from auth.users where email = 'REPLACE_WITH_YOUR_EMAIL@example.com');

commit;
