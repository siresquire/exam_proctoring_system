# USTED Exam Proctoring & Anti-Cheat Platform

Monorepo for the USTED exam proctoring platform. See [PLAN.md](PLAN.md) for the
architecture and phased roadmap, and [docs/DESIGN.md](docs/DESIGN.md) for the
design system and accessibility requirements (mandatory on every screen).

## Layout

```
apps/web            Next.js app (TypeScript, App Router, Tailwind, shadcn/ui)
packages/proctor-core   Framework-agnostic proctoring engine (shared by System 1 & 2)
supabase/            Supabase CLI project: config.toml, migrations/, seed.sql
docs/                Specs (RESEARCH.md, DESIGN.md)
.github/workflows/   CI + Supabase keep-alive cron
```

## Prerequisites

- Node.js 20+
- pnpm 9+ (`npm i -g pnpm` if you don't have it)
- Supabase CLI (`npm i -g supabase`) — only needed to apply migrations

## Setup

```bash
pnpm install
```

## Supabase setup (first time)

The app builds and runs without Supabase (the login page shows a friendly
"not configured" state), but sign-in needs a real project. Everything below
is free tier.

1. **Create the project.** Sign in at [supabase.com](https://supabase.com)
   (activate the GitHub Student Developer Pack first for extra credits),
   click **New project**, pick the free plan, choose a region close to Ghana
   (`eu-west-*` works well), and set a strong database password — save it in
   a password manager.

2. **Save the keys.** In the dashboard: **Project Settings → API**. Copy:
   - Project URL (`https://<project-ref>.supabase.co`)
   - `anon` public key
   - `service_role` key (server-only — treat like a password)

3. **Configure the app.**

   ```bash
   cp apps/web/.env.example apps/web/.env.local
   # then fill in NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
   # SUPABASE_SERVICE_ROLE_KEY (leave the R2_* placeholders empty for now)
   ```

4. **Apply the migrations.** From the repo root:

   ```bash
   supabase login                          # opens the browser once
   supabase link --project-ref <project-ref>
   supabase db push                        # applies supabase/migrations/*
   ```

5. **Create the first user.** Dashboard → **Authentication → Users → Add
   user** (email + password, check "auto confirm"). Or run `pnpm dev`, open
   `http://localhost:3000/login`, and use the magic-link tab. Either way a
   `profiles` row is created automatically (role `student`).

6. **Promote it to super_admin.** Dashboard → **SQL Editor**, run the
   snippet from [`supabase/seed.sql`](supabase/seed.sql) with your email:

   ```sql
   update public.profiles
   set role = 'super_admin'
   where id = (select id from auth.users where email = 'you@example.com');
   ```

   (Locally, `supabase db reset` applies `seed.sql` automatically once you
   put your email in it.) Every later role change goes through the
   `set_user_role` RPC, which enforces the escalation rules and writes the
   audit log — this SQL bootstrap is only for the very first super admin.

7. **Set the deployment secrets.**
   - **Vercel** (Project → Settings → Environment Variables):
     `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
     `SUPABASE_SERVICE_ROLE_KEY`.
   - **GitHub** (Repo → Settings → Secrets and variables → Actions):
     `SUPABASE_URL` and `SUPABASE_ANON_KEY` — used by the keep-alive cron
     ([.github/workflows/keepalive.yml](.github/workflows/keepalive.yml)),
     which pings the database every 3 days so the free-tier project never
     pauses. Trigger it once manually (Actions → Keepalive → Run workflow)
     to confirm it's green.

### Roles

Four roles, stored on `profiles.role` and enforced by Postgres RLS (the
client is never trusted): `super_admin`, `admin`, `lecturer`, `student`.

- **super_admin is intentionally universal**: it can do everything any other
  role can do, everywhere (it passes every `has_role()` check in SQL and
  every `requireRole()` check in the app, including the student dashboard).
- `admin` manages lecturers/students and accommodations; only `super_admin`
  may grant or revoke `admin`/`super_admin`; nobody may change their own
  role. All role changes go through the `set_user_role` RPC and land in the
  append-only `audit_log`.

### Regenerating DB types

`apps/web/lib/supabase/types.ts` is hand-written to match the migrations.
Once linked to a live project, replace it with generated types:

```bash
supabase gen types typescript --linked > apps/web/lib/supabase/types.ts
```

(Keep the `UserRole`/`Profile` convenience aliases at the bottom if you do.)

## Development

```bash
pnpm dev          # starts apps/web on http://localhost:3000
```

## Local development & testing

Everything below runs against a local Supabase stack in Docker — no cloud
project, no network calls out. This is the recommended way to develop and
test Phase 0+ before anything touches a hosted project.

### Prerequisites

- Docker Desktop running (`docker info` should succeed)
- Supabase CLI (`supabase --version`)

### Start / stop the stack

```bash
supabase start    # first run pulls images, can take 5-15 min
supabase status    # prints URLs + keys again later
supabase stop      # stop containers (add --no-backup to also drop volumes)
```

`supabase start` applies every migration in `supabase/migrations/` and then
`supabase/seed.sql` automatically. Key local endpoints (from `supabase
status`):

| Service | URL |
|---|---|
| API (`NEXT_PUBLIC_SUPABASE_URL`) | http://127.0.0.1:54321 |
| Studio (browse/edit data) | http://127.0.0.1:54323 |
| Postgres | postgresql://postgres:postgres@127.0.0.1:54322/postgres |
| Mailpit (magic-link emails) | http://127.0.0.1:54324 |

The anon key and service_role key change per machine/checkout — copy them
from `supabase status -o env` into `apps/web/.env.local` (see
`apps/web/.env.example`; `.env.local` is gitignored, never commit it).

For a completely clean slate (drops and recreates the local DB, reapplies
every migration + `seed.sql`):

```bash
supabase db reset
```

### Test users

Bootstrapped once via the Auth admin API (`POST /auth/v1/admin/users` with
`email_confirm: true`) and then promoted with direct SQL as `postgres` inside
a transaction that sets `usted.allow_role_change = 'on'` (the same escape
hatch `supabase/seed.sql` uses to bootstrap the first super_admin — see the
comment in that file). All other role changes go through the `set_user_role`
RPC.

| Email | Password | Role |
|---|---|---|
| `superadmin@usted.test` | `Usted!Test2026` | `super_admin` |
| `admin@usted.test` | `Usted!Test2026` | `admin` |
| `lecturer@usted.test` | `Usted!Test2026` | `lecturer` |
| `student@usted.test` | `Usted!Test2026` | `student` |

Recreate them any time with:

```bash
# (from repo root, stack running)
curl -s -X POST http://127.0.0.1:54321/auth/v1/admin/users \
  -H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email":"student@usted.test","password":"Usted!Test2026","email_confirm":true,"user_metadata":{"full_name":"Student Test"}}'
```

(`handle_new_user` auto-creates the `profiles` row on signup with the
default `student` role and the `full_name` from metadata; promote the other
three with the GUC-guarded SQL above, or with `set_user_role` once you have
one authenticated super_admin/admin session.)

### RLS / security smoke test

`scripts/rls-smoke-test.mjs` signs in as each of the four test users against
the **local** stack and asserts what RLS policies, guard triggers, and RPCs
should allow or reject — profile visibility, column-level update
restrictions, `log_audit`/`set_user_role` permission checks, admin/
super_admin escalation rules, audit log immutability, and anon access. It
prints PASS/FAIL per check, restores any role changes it makes so it's safe
to re-run, and exits non-zero if anything fails.

```bash
node scripts/rls-smoke-test.mjs
```

It reads Supabase URL/keys from `apps/web/.env.local` automatically (or from
the environment if you prefer — `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`). It refuses to
run against a non-`127.0.0.1`/`localhost` URL as a guardrail against
accidentally pointing it at a hosted project.

### App smoke test

```bash
pnpm dev   # from repo root, or `cd apps/web && pnpm dev`
```

Then confirm: `/` and `/login` return 200; `/dashboard` redirects
(307) to `/login` when signed out. Full sign-in flows are easiest to verify
by hand in the browser with the test users above — open
http://localhost:3000/login, sign in, and confirm you land on the
role-appropriate `/dashboard/*` screen.

## Verification

```bash
pnpm lint         # ESLint (apps/web)
pnpm typecheck    # tsc --noEmit across all workspace packages
pnpm build        # production build of apps/web
pnpm format       # Prettier write
pnpm format:check # Prettier check (CI-safe)
```

## Design system review

Run the dev server and open `/design` — it exercises every notification
variant, the theme toggle (light / dark / high-contrast), the accessible form
error pattern, a sample table, and icon+text buttons. This is the review
surface referenced by DESIGN.md §5 (Definition of Done).

In development, `axe-core` runs automatically (scanning the page on load and
every few seconds) and logs accessibility violations to the browser console.
(`@axe-core/react` was evaluated but dropped — its own README states it does
not support React 18+; it monkey-patches `React.createElement`, which throws
under React 19's module setup. Calling `axe.run()` directly has no such
issue.)

## Notes for contributors

- All popups/toasts/confirmations must go through `apps/web/lib/notify.ts`.
  Direct `sweetalert2` imports elsewhere are lint-banned.
- SQL is the security boundary: every privilege rule lives in Postgres
  (RLS policies, triggers, security-definer functions in
  `supabase/migrations/`). `requireRole()` in the app is UX-level routing,
  not security.
- The `audit_log` table is append-only (enforced in the DB); write to it
  only via the `log_audit()` SQL function.
- Cloudflare R2 (proctoring media) is wired up in Phase 1 — the `R2_*` env
  vars in `.env.example` are placeholders until then.
