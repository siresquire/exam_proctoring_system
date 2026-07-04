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
