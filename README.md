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

`db reset` wipes `auth.users` (test users are bootstrapped separately, see
below — they are **not** part of any migration or `seed.sql`), so re-run
`node scripts/seed-test-users.mjs` afterward. If `db reset` restarts
containers and the very next Auth admin API call 502s with "invalid
response was received from the upstream server", Kong's cached upstream IP
for the `auth` container is stale — `supabase stop && supabase start` (not
just `db reset`) fixes it.

### Test users

```bash
# (from repo root, stack running)
node scripts/seed-test-users.mjs
```

Idempotently (re)creates the four test users below via the Auth admin API
(`email_confirm: true`) and promotes their roles + seeds the student's
`student_number` with direct SQL as `postgres` inside a transaction that
sets `usted.allow_role_change = 'on'` (the same escape hatch
`supabase/seed.sql` uses to bootstrap the first super_admin — see the
comment in that file). Safe to re-run any time (e.g. after `db reset`); it
refuses to run against a non-local Supabase URL. All other, non-seed role
changes go through the `set_user_role` RPC.

| Email | Password | Role | student_number |
|---|---|---|---|
| `superadmin@usted.test` | `Usted!Test2026` | `super_admin` | — |
| `admin@usted.test` | `Usted!Test2026` | `admin` | — |
| `lecturer@usted.test` | `Usted!Test2026` | `lecturer` | — |
| `student@usted.test` | `Usted!Test2026` | `student` | `5201040845` |

(`handle_new_user` auto-creates the `profiles` row on signup with the
default `student` role and the `full_name` from metadata; promote the other
three with the GUC-guarded SQL above, or with `set_user_role` once you have
one authenticated super_admin/admin session.)

### RLS / security smoke test

`scripts/rls-smoke-test.mjs` signs in as each of the four test users against
the **local** stack and asserts what RLS policies, guard triggers, and RPCs
should allow or reject — profile visibility, column-level update
restrictions, `log_audit`/`set_user_role` permission checks, admin/
super_admin escalation rules, audit log immutability, anon access, the
proctoring session/event/media RPCs and RLS, and (Phase 1.5) violation
auto-termination (3 high-severity events → `terminated` + a
`proctor_reports` row the owner and any lecturer can read but other
students cannot), `start_proctor_session` refusing unattested sessions,
`identity_mismatch` logging on a claimed/registry index-number mismatch,
`attach_identity_portrait`'s one-shot + owner-only enforcement, and the
`profiles.student_number` 10-digit `CHECK` constraint. It prints PASS/FAIL
per check, restores any role changes it makes so it's safe to re-run, and
exits non-zero if anything fails.

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

## Proctoring engine & demo

`packages/proctor-core` is the framework-agnostic engine shared by System 1
(Forms wrapper, Phase 2) and System 2 (platform exam room, Phase 4): a
heartbeat/event-capture pipeline (tab switches, window blur, fullscreen
exit, clipboard use, right-click, connection loss), an offline-buffered
batched event queue, and webcam snapshot capture. It has zero framework
coupling — `apps/web/lib/proctor/supabase-adapters.ts` is the only place
Supabase-specific code touches it (implements the `ProctorTransportAdapter`
and `ProctorStorageAdapter` interfaces the engine expects).

Open `/proctor-demo` (any signed-in role) for a live walkthrough: consent →
identity verification → camera check → a monitored session running a
5-question sample quiz. Try switching tabs, exiting fullscreen, copying
text, or going offline — each appears in the live event feed with a
severity level.

### Violation threshold & auto-termination (Phase 1.5)

Every `proctor_sessions` row carries a `violation_limit` (default 3) and a
`violation_count`. The **server** — never the client — counts high-severity
events inside the `log_proctor_events` RPC; once the count reaches the
limit, the RPC atomically terminates the session (`status = 'terminated'`),
appends a `session_terminated` event, and files a `proctor_reports` row
(`reason = 'violation_limit_reached'`, a summary of event counts by
severity/type, `status = 'pending_review'`). The RPC's return value
(`{ accepted, session_status, violation_count, violation_limit }`) is how
the client learns about termination — `packages/proctor-core`'s
`ProctorEngine.onTerminated()` fires from that response, not from a
client-side count, so a hostile client cannot dodge it by simply not
reporting events truthfully (the events it *does* report are what triggers
termination, and refusing to report at all just stalls the exam, which is
its own signal). Before termination, each high-severity violation shows a
calm `notify.examWarning` toast ("Violation N recorded — …"); on
termination the demo locks the quiz UI and shows a "submitted for review"
summary. `proctor_reports` is append-only and readable by the session owner
and any `lecturer`-or-higher role; the review workflow (setting
`verdict`/`reviewed_by`/`reviewed_at`) is Phase 4.

### Identity verification (Phase 1.5)

Before a session can start, the student goes through `IdentityCheck`
(`apps/web/components/proctor/identity-check.tsx`): a 10-digit USTED index
number field, a live camera capture with a face-outline guide overlay (no
ML/face matching — the photo is evidence for a human reviewer), and an
explicit attestation checkbox naming the academic-integrity consequences of
impersonation. `start_proctor_session` refuses to create a session unless
`attested = true`; the entered index number is cross-checked against
`profiles.student_number` when that column is set — a mismatch logs a
high-severity `identity_mismatch` event but does **not** block session
creation (registry data can lag reality; the portrait is the primary
evidence). The portrait itself is uploaded to the `proctoring` bucket after
the session is created, then linked with the one-shot
`attach_identity_portrait(session_id, storage_path)` RPC (owner-only, own
active session, only while no portrait is already attached).
`profiles.student_number` has a `CHECK (student_number ~ '^\d{10}$')`
constraint (USTED index numbers, e.g. `5201040845`); the local seed data
sets it for `student@usted.test` only — staff profiles stay `NULL`.

### Branding & accessibility extras (Phase 1.5)

- AAMUSTED's crest+wordmark (`apps/web/public/aamusted-logo.png`) is in the
  site header (~40px), and larger on `/login` and the home page, each with a
  descriptive `alt`. The home page footer credits AAMUSTED. The favicon was
  **not** replaced — see the comment in `apps/web/app/layout.tsx`'s
  `metadata` for why (the full logo doesn't survive being shrunk to a
  16–32px square; cropping just the crest needs real image processing this
  repo doesn't have).
- The brand palette (maroon primary / gold accent / green success) was
  sampled programmatically from the logo file — see
  `scripts/derive-brand-palette.mjs` (run it yourself:
  `node scripts/derive-brand-palette.mjs`) — and applied to
  `apps/web/app/globals.css` across all three themes, each pairing
  re-verified ≥ 4.5:1 contrast. See docs/DESIGN.md §1 for the exact hex
  values and ratios.
- A text-size control (100% / 112.5% / 125% / 150%) sits next to the theme
  toggle in the header and on `/design`. It scales `<html>`'s font-size —
  the whole app is `rem`-based, so every screen scales with it — and is
  persisted + applied before first paint (no flash of unscaled text), the
  same technique `next-themes` uses for color scheme.

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
  only via the `log_audit()` SQL function. `proctor_events`, `proctor_media`,
  and `proctor_reports` follow the same append-only posture (revoked direct
  DML + a trigger that rejects UPDATE/DELETE outright).
- Cloudflare R2 (proctoring media) is wired up in Phase 1 — the `R2_*` env
  vars in `.env.example` are placeholders until then.
- `packages/proctor-core` must stay framework-agnostic: no React, no
  `@supabase/*` import anywhere in that package. New signals/adapters go
  through the existing `ProctorTransportAdapter`/`ProctorStorageAdapter`
  interfaces; identity-verification UI lives entirely in `apps/web` — the
  engine only exposes the generic `onTerminated()` hook it needs.
