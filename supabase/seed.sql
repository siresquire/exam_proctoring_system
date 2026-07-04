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
--   3. Run `supabase db reset` (local) — or run the `update` statement by
--      hand in the SQL editor of your hosted project (see README.md
--      "Supabase setup" for the hosted equivalent; seed.sql itself never
--      runs against a hosted project).

update public.profiles
set role = 'super_admin'
where id = (select id from auth.users where email = 'REPLACE_WITH_YOUR_EMAIL@example.com');
