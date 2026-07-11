# USTED Exam Proctoring & Anti-Cheat Platform

Monorepo for the USTED exam proctoring platform. See [PLAN.md](PLAN.md) for the
architecture and phased roadmap, and [docs/DESIGN.md](docs/DESIGN.md) for the
design system and accessibility requirements (mandatory on every screen).

## Layout

```
apps/web            Next.js app (TypeScript, App Router, Tailwind, shadcn/ui)
packages/proctor-core   Framework-agnostic proctoring engine (shared by System 1 & 2)
supabase/            Supabase CLI project: config.toml, migrations/, seed.sql
apps-script/         Google Apps Script for the Phase 2b Forms bypass-detection webhook
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
   user** (email + password, check "auto confirm"). A `profiles` row is
   created automatically (role `student`) by the `handle_new_user` trigger.
   There is no self-signup page — see "Self-signup is disabled" below.

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
- **Users & roles → Create user** (`/dashboard/users`, admin/super_admin
  only) creates an account directly with a chosen role, instead of only via
  the class-roster path. The role you're allowed to hand out mirrors
  `set_user_role`'s escalation rules exactly: an `admin` may create
  `lecturer`/`student` accounts only; a `super_admin` may create any of the
  four. That check runs server-side in `createUserAccount`
  (`apps/web/app/dashboard/users/actions.ts`) **before** any account is
  created, and — for staff roles — the actual role assignment still goes
  through the `set_user_role` RPC (never a direct `profiles.role` write), so
  Postgres re-enforces the same rule and audit-logs it. New accounts get a
  server-generated, crypto-random temp password shown to the admin **once**
  (never stored in plaintext) and `must_change_password = true`, exactly
  like the roster-import flow.

### Sign-in: email or index number (Phase 1.6)

The login page accepts **either** a university email **or** a 10-digit USTED
index number (e.g. `5201040845`), plus a password. Index resolution happens
entirely server-side in the `signIn` server action
(`apps/web/app/login/actions.ts`): if the identifier is 10 digits it is
looked up via a **service-role** client (`apps/web/lib/supabase/admin.ts`,
server-only — the key is never shipped to the browser and the index→email
mapping is never exposed) and the resolved email is used for the real
password sign-in. Every failure returns one generic "Invalid email/index
number or password" so the form is not an account-enumeration oracle. This
exists because student onboarding must not depend on email deliverability
before a domain is purchased (see PLAN.md "Student onboarding without a
domain"): admins hand out index + temp password (roster import) or a real
email + temp password (the "Create user" console below).

### Self-signup is disabled

There is no way to create an account from the login page. This is
deliberate, at both layers:

1. **App layer.** No code path calls `supabase.auth.signUp()` or
   `supabase.auth.signInWithOtp()`. Accounts are created only server-side,
   via the service-role Admin API, from two places: the class-roster
   import/"Add student" flow (`apps/web/lib/onboarding/create-student.ts`,
   students only) and the **Users & roles → Create user** console
   (`apps/web/app/dashboard/users/actions.ts`'s `createUserAccount`, any
   role an admin/super_admin is allowed to grant — see "Roles" above).
   The login page used to have an "Email me a link" magic-link tab; it was
   removed because `signInWithOtp()` without `shouldCreateUser: false`
   silently creates a brand-new account for **any** email address that
   doesn't already exist — i.e. it was an open self-signup form (this is
   exactly how an uninvited account got created on the live deployment).
2. **Supabase project layer**, belt-and-braces in case the app layer is ever
   bypassed: `enable_signup = false` in `supabase/config.toml` (local dev —
   note this does **not** affect the service-role Admin API, so admin/
   lecturer/student account creation above still works). On the **hosted**
   project, the equivalent is a manual dashboard step the project owner
   must perform: **Authentication → Sign In / Providers → Email → "Allow new
   users to sign up"** → **OFF**.

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
| Mailpit (local outbound-email catcher, currently unused — self-signup/magic-link is disabled) | http://127.0.0.1:54324 |

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
`attach_identity_portrait`'s one-shot + owner-only enforcement, the
`profiles.student_number` 10-digit `CHECK` constraint, and (Phase 1.7) the
server-assigned-severity anti-tamper property (a client-claimed severity is
overridden by the session's policy), custom-policy overrides (an event set to
`counts: false` does not terminate), `violation_policy` validation, and
`display_configuration_changed` counting by default. Phase 2a adds a section
covering `forms_exams` RLS (draft invisible to students, published+open
visible), `start_forms_exam_session`'s exam-owned tier/policy enforcement
(refuses on draft/closed/out-of-window, and the created session's
`violation_policy`/`integrity_tier` provably come from the exam row, not the
caller), the `forms_exam_sessions` results RPC's owner-or-lecturer guard, and
a **security regression check**: a signed-in student calling the internal
`_create_proctor_session` helper directly via `rpc()` must be denied — this
guards the lock-down migration (`20260705000006`) that closed a real bypass
(Postgres/Supabase grant `EXECUTE` to `PUBLIC`/`authenticated` by default, so
the helper was callable over PostgREST despite the leading-underscore naming
convention, letting a student mint a session with an arbitrary policy).
Phase 2b adds a section covering the Apps Script bypass-detection webhook
(`rotate_forms_exam_secret` ownership gating, the wrong/missing-secret 401s,
each `match_status` classification, `forms_submissions` append-only
enforcement, and the `match_forms_submission` lock-down). Phase 3a adds a
section covering classes/enrollment/onboarding — see "Classes, enrollment &
onboarding (Phase 3a)" above for what it checks. It prints PASS/FAIL per
check (163 checks as of Phase 3a), restores any role changes it makes and
deletes any rows it created so it's safe to re-run, and exits non-zero if
anything fails.

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
`violation_count`. The **server** — never the client — counts violations
inside the `log_proctor_events` RPC (which events count, and their severity,
comes from a per-session policy as of Phase 1.7 — see below); once the count
reaches the
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

- USTED's crest+wordmark (`apps/web/public/aamusted-logo.png`) is in the
  site header (~40px), and larger on `/login` and the home page, each with a
  descriptive `alt`. The home page footer credits USTED. The favicon was
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

### Navigation

The header's primary nav (`apps/web/components/layout/site-header.tsx` +
`primary-nav.tsx`) is role-aware, not a fixed list of every tab for everyone:
`apps/web/components/layout/nav-config.ts` maps each `UserRole` to its own
link groups (student: just Dashboard; lecturer: Dashboard, Question banks,
Exams, Classes, Forms quizzes; admin: Dashboard, Classes, Users & roles,
Audit log; super_admin: all of the above, grouped as "Teaching" /
"Administration"), plus "Proctoring demo" appended for every signed-in role
(it's a training/review surface, not a staff-only tool). Signed-out visitors
see only the brand mark and a "Sign in" button — no app links. `SiteHeader`
resolves the session server-side via `getSessionProfile()` (the same
cookie-decoding path `requireRole` uses — see `lib/auth.ts`) and passes
`role`/`fullName`/`email` down as props, so there's no client-side session
fetch to race the middleware's token refresh.

Above the `md` breakpoint the role's links render inline in one row
(wrapping gracefully for `super_admin`'s longer list at narrow desktop
widths); below it, the header collapses to just the logo and a hamburger
button (`aria-label`, `aria-expanded` via Radix, ≥44×44px target) that opens
a shadcn **Sheet** drawer. The drawer holds the same role-scoped links
(grouped under labeled headings for `super_admin`), then the signed-in
identity, the text-size and theme controls, and sign-out — so the mobile
top bar never wraps into multiple rows. Radix's Dialog primitive under the
Sheet gives focus-trap, Escape-to-close, and scroll-lock for free; each link
is wrapped in `SheetClose` so tapping it navigates and closes the drawer in
one action. The drawer uses a single `<nav>` landmark for the whole link
list (per-group headings are plain `<h2>`s, not nested `<nav>`s) to avoid
an axe-core `landmark-unique` violation from two same-labeled navs.

`/design` (the shadcn/notify.ts component gallery) was dropped from the
primary nav entirely — it's a developer surface, not something students or
staff need to reach from the app chrome. The route itself is untouched.

### Face-presence detection & portrait quality gating (Phase 1.6)

`packages/proctor-core` defines a framework-agnostic `FaceDetector` interface
(`detect(bitmap) -> Promise<{ faceCount }>`) — the engine calls it once per
webcam snapshot (`engine.processSnapshot(bitmap)`) but never imports any ML
runtime itself. `apps/web/lib/proctor/face-detector.ts` is the only place
`@mediapipe/tasks-vision` is imported: it wraps MediaPipe Tasks Vision's
BlazeFace short-range detector and is injected into the engine by
`proctor-demo.tsx`. **Self-hosted**: the WASM runtime
(`apps/web/public/mediapipe/`, copied from
`node_modules/@mediapipe/tasks-vision/wasm/`) and the model file
(`apps/web/public/models/blaze_face_short_range.tflite`, downloaded from
Google's model store) are committed static assets served same-origin, for
offline/low-bandwidth resilience — see `apps/web/public/models/README.md`
for the regeneration commands. `face-detector.ts` falls back to the
jsdelivr/Google-Storage CDN only if those local files are ever missing, with
a console warning in development and a `TODO(production)` comment — treat
that path as a safety net, not the intended production setup.

Two new events, both a soft signal that only ever feeds the same
human-review pipeline as every other proctoring flag (never an automatic
penalty — RESEARCH.md §3 documents face-detector accuracy gaps in low light
and for darker skin tones, which is exactly why this is debounced and
reviewer-gated):

- `no_face_detected` — **debounced**: only emitted after `noFaceThreshold`
  (default 2) *consecutive* no-face snapshots (~40s at the default 20s
  snapshot interval). A face reappearing resets the streak. Default severity
  `medium`, overridable per-engine via `noFaceSeverity` (the demo harness
  lets you flip it to `high` to watch it start counting toward the 3-strike
  termination limit).
- `multiple_faces_detected` — **not** debounced (2+ faces in a single frame
  is a stronger signal than one bad frame). Default severity `high`,
  overridable via `multipleFacesSeverity`.

Both event types were added to `proctor-core`'s `ProctorEvent` union and to
the server-side vocabulary in
`supabase/migrations/20260705000003_proctor_face_detection_events.sql` (the
`proctor_events.event_type` CHECK constraint and `log_proctor_events`'s
inline validation list — copied from 20260705000001's version with just the
two new values added). Unit tests for the debounce/threshold/reset/
severity-override logic live in
`packages/proctor-core/src/face-detection.test.ts` (a fake `FaceDetector`,
no real ML).

`IdentityCheck` (`apps/web/components/proctor/identity-check.tsx`) reuses the
same MediaPipe detector to **gate** the identity portrait itself before
accepting it: brightness (mean luma), sharpness (a Laplacian-variance-style
high-frequency-energy heuristic), and exactly-one-face, all client-side on
the captured canvas. A failing photo is rejected with specific guidance
(too dark/bright, blurry, no face, multiple faces) via `notify.*` and an
aria-live status update, and the student stays on the retake step — glasses
are never blocked (only advisory text), since eyewear detection isn't
attempted.

### Configurable violation policy, server-assigned severity & display detection (Phase 1.7)

**Anti-tamper fix.** Before Phase 1.7 the client reported each event's
severity, so a hacked client could label everything `info` and never
accumulate a strike. Now severity **and** whether an event counts toward the
limit are assigned **server-side** from a policy snapshot stored on the
session (`proctor_sessions.violation_policy`, a jsonb map of
`event_type -> { severity, counts }`). `log_proctor_events` reads that snapshot
and ignores the client's claimed severity entirely — verified by the RLS smoke
test (a client sending `severity: info` for a `tab_hidden` still gets stored
`high` and still counts).

- **Default policy** (`public.default_violation_policy()`, the single source of
  truth): **every** violation-type signal counts toward the 3-strike
  termination by default (user directive — students stay on screen and answer);
  only benign lifecycle/observation events (heartbeat, snapshots, tab_visible,
  focus regained, `multi_monitor_detected` start-of-session observation, …) are
  exempt. `connection_lost` counts by default, but the policy editor carries a
  fairness note recommending lecturers exempt it for low-bandwidth/mobile
  cohorts (it collides with autosave/resume otherwise).
- **Configurable** by lecturer/admin/super_admin: `start_proctor_session` takes
  an optional `violation_policy` of partial overrides, strictly validated
  (unknown event types, bad severity values, non-boolean `counts` all raise)
  and merged over the default. The demo exposes this as a
  `ViolationPolicyEditor` step (`apps/web/components/proctor/violation-policy-editor.tsx`);
  Phase 3/4 will set it per exam and have server code pass it in when a student
  begins their attempt (the signature already supports that call shape).
- **Display-change detection**: `display_configuration_changed` fires when a
  monitor is plugged in / unplugged / the layout changes mid-session — detected
  via `screen.addEventListener('change')`, an opportunistic
  `getScreenDetails().screenschange` listener (only if the `window-management`
  permission is already granted — never prompts), and a permission-free ~10s
  poll of `isExtended`/geometry, de-duped so it emits once per change.
  `multi_monitor_detected` remains the one-shot start-of-session observation.

**Honest limits (documented, not hidden).** A browser cannot see everything:
- **Mirrored splitters / capture cards** are invisible — the OS reports a
  single display, so no web API can detect them.
- **Remote-control software** (TeamViewer, AnyDesk, …) cannot be enumerated by
  a browser at all.
These are exactly what **Tier 4 + Safe Exam Browser** (Phase 6) exists for;
in-browser we catch only their side effects (focus flapping, display changes),
and the webcam/face layer covers the rest.

### Cloudflare R2 storage (optional, env-gated)

Proctoring media (webcam snapshots + identity portraits) uses **Supabase
Storage by default**, unchanged. Cloudflare R2 (10GB free, zero egress —
PLAN.md §1) is available as an **opt-in alternative**, fully dormant until
explicitly turned on:

- **Provider selection**: `NEXT_PUBLIC_STORAGE_PROVIDER` (public, non-secret —
  it only picks a code path, never a credential). Empty or anything other
  than `"r2"` = Supabase Storage, exactly as today. `"r2"` = Cloudflare R2.
  `apps/web/lib/proctor/storage-adapter.ts`'s `createProctorStorageAdapter()`
  factory branches on this flag; `getStorageProvider()` reads it once.
- **The R2 secret never reaches the browser.** `apps/web/lib/storage/r2.ts`
  holds `R2_SECRET_ACCESS_KEY` server-only (a `typeof window` runtime guard
  throws if it's ever imported into client code, mirroring
  `lib/supabase/admin.ts`'s pattern) and only ever hands the browser a
  short-lived **presigned URL**, signed with `aws4fetch` (SigV4 query
  signing — R2 is S3-API-compatible). The browser does a plain `fetch(url,
  { method: 'PUT' | 'GET' })` against that URL; it never sees the key/secret.
- **Two server actions re-derive the Storage RLS by hand**
  (`apps/web/lib/proctor/storage-actions.ts`) — R2 has no RLS of its own, so
  these two functions ARE the entire security boundary once R2 is active:
  - `presignMediaUpload(sessionId, ext, contentType)`: mirrors the
    `proctoring_insert_own_active_session` policy
    (`20260704000007_proctor_rls_and_storage.sql`) — the caller must own
    `sessionId` **and** that session must be `status = 'active'`, checked via
    the caller's cookie-bound Supabase client (`supabase.auth.getUser()` +
    a `proctor_sessions` row lookup). The object key
    (`${sessionId}/${randomUUID()}.${ext}`) is generated **server-side**,
    never trusted from the client, enforcing the same `{session_id}/...`
    prefix the SQL policy's `storage.foldername(name))[1]` check requires.
  - `presignMediaRead(storagePath)`: mirrors
    `proctoring_select_own`/`proctoring_select_lecturer_or_higher` combined —
    the session owner, or anyone for whom `has_role('lecturer')` is true
    (called via the same `has_role` RPC the SQL policies use — note this is
    an **exact** role match plus super_admin's universal pass, not "admin or
    higher", exactly like the SQL).
- **Identity portraits and snapshots both** route through this same
  provider-agnostic layer (`uploadIdentityPortrait()` and
  `createProctorStorageAdapter().uploadSnapshot()`); `record_proctor_media`
  and `attach_identity_portrait` are unchanged RPCs either way — they just
  store whichever `storage_path`/key they're given.

**Enabling R2** (owner's activation steps — cannot be tested end-to-end until
real credentials exist, so this is the exact runbook to follow once they do):

1. In Vercel (Project Settings → Environment Variables), set:
   `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`
   (the bucket name, e.g. `usted-proctoring-media`), and
   `NEXT_PUBLIC_STORAGE_PROVIDER=r2`. The R2 secret lives **only** in
   Vercel's environment variables — never in a repo file, never in
   `.env.local` on a shared machine.
2. Add a **CORS policy** to the R2 bucket (Cloudflare dashboard → R2 → the
   bucket → Settings → CORS Policy) — the browser's `fetch(url, { method:
   'PUT' })`/`GET` calls need this or they fail with a CORS error:
   ```json
   [
     {
       "AllowedOrigins": ["https://usted-proctor.vercel.app"],
       "AllowedMethods": ["GET", "PUT"],
       "AllowedHeaders": ["*"],
       "ExposeHeaders": [],
       "MaxAgeSeconds": 3600
     }
   ]
   ```
   Replace the origin with the actual deployed URL (add both the production
   domain and any preview-deployment domain you test against).
3. Redeploy (env var changes require a new deployment to take effect).
4. Verify: open `/proctor-demo`, go through consent → identity verification
   (this uploads the portrait) → start a session and let it take a snapshot
   (every 20s, or wait for the first one). Confirm:
   - The object appears in the R2 bucket under `<session_id>/...` (Cloudflare
     dashboard → R2 → the bucket → Objects).
   - The in-page snapshot thumbnail still renders (it uses a local blob URL
     for the just-captured frame, so this alone doesn't prove the read path —
     but a failed `uploadSnapshot()` call logs `"Snapshot upload failed"` to
     the browser console, so an absence of that error plus the object
     appearing in the bucket together confirm the R2 upload path works).
   - No console errors from `presignMediaUpload`/`presignMediaRead`.
5. To roll back at any point: unset `NEXT_PUBLIC_STORAGE_PROVIDER` (or set it
   to anything other than `"r2"`) and redeploy — the app returns to Supabase
   Storage immediately, with zero data migration (existing R2 objects simply
   stop being referenced by new uploads; nothing reads or writes them).

## System 1 — proctored Google Forms wrapper (Phase 2a)

System 1 wraps an ordinary Google Form with the same proctoring engine used
throughout this repo, without touching the form itself. It ships ahead of the
full exam platform (System 2, Phase 3+) because a lecturer can be using it
this week.

### Lecturer flow

1. `/dashboard/lecturer/forms-exams` → **New Forms quiz**
   (`apps/web/components/forms/forms-exam-form.tsx`): title, the Google Form's
   response link, an integrity tier (T1–T4, PLAN.md §2), an optional
   opens/closes window and duration, and the same `ViolationPolicyEditor` the
   Phase 1.5/1.7 demo uses — reused wholesale, not reimplemented.
2. The pasted URL is normalized both client-side (immediate feedback) and
   server-side (`apps/web/lib/forms/google-form-url.ts`, called again in the
   `createFormsExam`/`updateFormsExam` server actions — never trust the
   client's normalization). It accepts the standard
   `.../forms/d/e/<id>/viewform` share link, strips tracking params, and
   rewrites it to `.../viewform?embedded=true` (Google's documented iframe
   query param). The **edit** link (`.../edit`) and `forms.gle` short links
   are explicitly rejected with guidance, since both are common copy-paste
   mistakes that would either leak the lecturer's authoring URL or need a
   server-side redirect fetch this function deliberately avoids.
3. Saved as `status = 'draft'` — invisible to students regardless of the
   window (`forms_exams` RLS, see below) — until the lecturer clicks
   **Publish** from the list. **Copy link** gives the student URL
   (`/exam/forms/<id>`); **Close** stops new sessions without affecting
   already-open ones; **Reopen as draft** undoes an accidental close.
4. **Results** (`/dashboard/lecturer/forms-exams/<id>/results`) lists every
   proctoring session started against that quiz via the `forms_exam_sessions`
   RPC: student name/index number, session status, strikes (`violation_count`
   / `violation_limit`), start/end times, and whether a `proctor_reports` row
   exists (pending human review). This is deliberately thin — it links to the
   event history in Studio for now rather than reimplementing Phase 4's
   review workspace.

### Student flow

`/exam/forms/<id>` runs the same phase machine as `/proctor-demo` (consent →
identity verification → live monitoring → summary), built from the identical
Phase 1/1.5/1.6 components (`ConsentScreen`, `IdentityCheck`, `EventFeed`,
the MediaPipe face-detector adapter) — but the **exam's own Google Form**
renders inside the live-monitoring iframe instead of a sample quiz, and there
is no policy-editing step: the tier and violation policy are fixed by the
lecturer and loaded server-side (see below). When finished, the student
clicks **"I have submitted the form"**, confirms via a `notify.confirm`
dialog, and gets a session summary (event counts by severity, snapshot
count).

### The honest cross-origin limitation

The Google Form runs entirely on Google's servers inside a cross-origin
iframe. We structurally **cannot** read its questions, the student's answers,
or detect Google's own submit action — the wrapper monitors the *exam
environment* (tab switches, window focus, fullscreen exits, clipboard use,
webcam presence, extra displays), exactly the same signals used everywhere
else in this platform, and nothing more. This is disclosed to the student on
the intro screen and again as a persistent notice during the live session,
and it is why submission is a manual, self-reported step rather than an
automatic detection — Phase 2b's `onFormSubmit` Apps Script cross-check
(below) narrows this gap but can never close it entirely.

### Embedding caveat and the graceful fallback

A Google Form only embeds in an iframe if it is public ("Anyone with the
link can respond"). A form restricted to signed-in users within an
organization sends `X-Frame-Options`/refuses the embed via Google's own
login redirect, and the iframe simply never fires its `load` event — there is
no cross-origin-safe way to inspect *why* it failed. The wrapper
(`apps/web/components/forms/forms-exam-wrapper.tsx`) handles this with a
timeout (8s from entering the live phase): if `load` hasn't fired by then, it
assumes the embed was blocked and swaps in a fallback panel with an "open the
form in this monitored window" link (`target="_self"`, so it navigates within
the same monitored tab rather than opening a new one proctor-core can't see).
Monitoring keeps running throughout either way.

### Tier and violation policy are exam-owned, enforced server-side

The single most important security property of Phase 2a: **the student has
no way to choose or override the tier or violation policy for a Forms exam.**
`start_forms_exam_session(forms_exam_id, claimed_index_number, attested)`
has no `tier`/`violation_policy` parameter at all — it loads both from the
`forms_exams` row server-side and refuses unless `status = 'published'` and
`now()` is inside `[opens_at, closes_at]`. This is structural, not a
convention: even a fully hostile client cannot pass a different policy in,
because there is nothing in the function's signature to pass it through.

Under the hood, `start_proctor_session` (the Phase 1 demo/self-service path,
which *does* accept a caller-supplied policy override) and
`start_forms_exam_session` both delegate the actual row-creation work
(concurrent-session abandon+flag, insert, `session_start` event, identity
cross-check) to a shared internal helper, `public._create_proctor_session`.
That helper does **no** policy validation itself — it trusts whatever
tier/policy it's handed, because its only intended callers are the two
functions above, which each produce a validated/trusted policy before
delegating.

**This shared-helper design initially shipped with a real security hole**
(migration `20260705000005`): Postgres grants `EXECUTE` on new functions to
`PUBLIC` by default, and Supabase additionally grants it to
`anon`/`authenticated` — so despite the leading-underscore "internal, don't
call this" naming convention, `_create_proctor_session` was directly
reachable over PostgREST (`rpc('_create_proctor_session', {...})`) by any
signed-in student, who could hand it an all-`counts:false` policy and get
back a live session that could never hit the violation limit, completely
bypassing the exam-owned guarantee above. Migration
`20260705000006_lock_down_create_proctor_session_helper.sql` fixes this with
a single `REVOKE EXECUTE ... FROM PUBLIC, anon, authenticated`; the two
security-definer callers are unaffected (they execute as the function owner,
which retains its own `EXECUTE` grant). The RLS smoke test's Phase 2a section
asserts this directly and will fail loudly if the lock-down is ever
accidentally reverted. The lesson generalizes: naming conventions are not
access control in Postgres — every function reachable via `rpc()` needs an
explicit `GRANT`/`REVOKE` decision, "internal" or not.

### Bypass detection (Phase 2b)

Phase 2a's biggest structural gap: a student who learns the raw Google Form
URL can skip the proctored wrapper entirely and submit unproctored, and we
have **no way to see that submission at all** — it never touches our
servers. Phase 2b closes part of that gap with an Apps Script
`onFormSubmit` cross-check that runs on Google's side and reports every
submission (wrapped or bypassed) back to the platform.

**How it works.** The lecturer installs a small Apps Script
(`apps-script/forms-proctor-crosscheck.gs`, full install steps in
`apps-script/README.md`) directly on their Google Form. Its `onFormSubmit`
installable trigger fires in Google's cloud after every submission and POSTs
`{ forms_exam_id, respondent_email, submitted_at }` to
`POST /api/forms/submission`, authenticated by a per-exam shared secret
(`forms_exams.submission_secret`) sent as the `x-forms-secret` header. The
lecturer generates/rotates this secret from the Results page's **"Bypass
detection (Apps Script)"** panel (`rotate_forms_exam_secret` RPC,
owner-or-lecturer-or-higher only) — shown once, like an API key, alongside
the `WEBHOOK_URL`/`FORMS_EXAM_ID` values to paste into the script.

**Trust model.** The route (`apps/web/app/api/forms/submission/route.ts`) is
intentionally public/unauthenticated by session — Apps Script has no
Supabase session to send — and trusts **exactly one thing**: a
constant-time (`crypto.timingSafeEqual`) comparison of the supplied secret
against the exam's stored `submission_secret`. Everything else in the body
(`respondent_email`, `submitted_at`) is unverified input from Google's side,
recorded and then cross-checked against our own `proctor_sessions` data —
never taken as a claim of identity on its own. Wrong or missing secret → 401;
unknown `forms_exam_id` → 404; the body is size- and field-capped before any
DB write. Writes go through the service-role client
(`lib/supabase/admin.ts`) since there is no authenticated user on the
request to key RLS off.

**Cross-check classification** (`match_forms_submission`, a
service-role-only SQL helper — `EXECUTE` revoked from `anon`/`authenticated`,
same lock-down pattern as `_create_proctor_session`/`20260705000006`, so a
student cannot use it to fish for "does this email have a session"):
resolves `respondent_email` to an `auth.users` id, finds that user's
`proctor_sessions` row for `context = 'form:<forms_exam_id>'`, and returns
one of four outcomes, stored on `forms_submissions.match_status`:

| Status | Meaning |
|---|---|
| `matched` | A proctored session exists and `submitted_at` falls inside it. |
| `out_of_window` | A session exists, but the submission timestamp is outside `[started_at, ended_at or now]`. |
| `no_session` | **The bypass flag** — no proctored session exists at all for that email against this form. |
| `no_email` | The submission carried no email (the form's "Collect email addresses" setting is off). |

`forms_submissions` is append-only: no INSERT/UPDATE policy exists for any
client role (only the service-role webhook writes), and an UPDATE-blocking
trigger stops even the service role from editing a row after the fact.
DELETE is deliberately *not* trigger-blocked (only REVOKEd from
`anon`/`authenticated` + no RLS policy) so that deleting the parent
`forms_exams` row can still cascade — an earlier draft of this migration
blocked DELETE unconditionally and broke exactly that cascade, caught by the
smoke test's `p14e` regression check.

Results surface next to the proctoring sessions table
(`forms_exam_submissions` RPC, owner-or-lecturer-gated like
`forms_exam_sessions`): respondent email, submission/report timestamps, and
a match-status badge that always pairs an icon with text, never color alone
(WCAG 2.2 AA).

**Honest limits** (see `docs/RESEARCH.md` §1 and `apps-script/README.md`):
matching is by email, so it depends on the form collecting one; a
determined student submitting via a direct API call rather than Google's
own form-submit UI would not trigger `onFormSubmit` either. This is a
detection/deterrence signal for lecturer review — consistent with PLAN.md
§0 — never an automatic penalty.

## Classes, enrollment & onboarding (Phase 3a)

The onboarding tooling that lets a lecturer run a real class through the
platform **before USTED buys a domain** — no student email address is
required anywhere in this flow (PLAN.md "Student onboarding without a
domain").

### Classes and rosters

Lecturers (and admins) create classes from **Dashboard → Classes &
enrollment** (`create_class` RPC, lecturer-or-higher only) and open one to
see its roster. RLS matrix (`supabase/migrations/20260705000008_classes_enrollment.sql`):
the owner or *any* lecturer can manage a class (same "any lecturer" known
simplification as `forms_exams`/`proctor_*` elsewhere in this codebase —
Phase 4 scopes it to ownership/co-teaching); a student may only `SELECT`
their **own** `class_members` row (`student_id = auth.uid()`), never a
classmate's — the full roster with names is only readable through the
owner-or-lecturer-gated `class_roster()` RPC.

### The synthetic-email identity model

There is no verified sending domain, so a student account cannot depend on
real email. Every student created through this flow gets:

- A **non-routable synthetic email**, `<10-digit index>@students.usted.local`
  (`apps/web/lib/onboarding/student-email.ts`) — `.local` is reserved by RFC
  6762 for link-local mDNS and is not resolvable on the public internet, so
  even if this address ever leaked into a real "email" field somewhere,
  nothing could be delivered to it. It exists purely as a stable internal
  auth identifier.
- A **crypto-random temp password** (`generateTempPassword()`,
  `lib/onboarding/temp-password.ts` — Web Crypto `getRandomValues`, not
  `Math.random()`, and excludes visually-confusable characters like `0/O`
  and `1/l/I` since it's read off a printed roster and typed back in, often
  on a phone).
- `profiles.must_change_password = true`.

The account is created via the Auth admin API
(`apps/web/lib/onboarding/create-student.ts`, service-role only —
`email_confirm: true` since there's no inbox to confirm from). **The
existing index-number sign-in path (`app/login/actions.ts`,
`resolveEmailForIndexNumber`) needs no changes at all**: it already resolves
`profiles.student_number` → `auth.users.id` → that user's email, and the
synthetic email is exactly what's stored there, so a brand-new student signs
in with their index number and temp password on the very first try.

**The temp password is never stored anywhere.** It's generated, used once to
set the account's initial password, and returned to the caller in memory for
that one request/response — there is no column, table, or log holding it.
Losing it means calling `regenerate_temp_password` (via
`regenerateStudentPassword` server action, lecturer/admin only), which
re-issues a fresh one through the Auth admin API's `updateUserById` and
re-sets `must_change_password = true`.

### Forced first-login password change

Any signed-in user with `profiles.must_change_password = true` is redirected
to `/onboarding/set-password` before reaching any dashboard —
`requireRole()` (`lib/auth.ts`) checks the flag before its role check runs,
for every dashboard layout in the app. The page itself uses a separate
`requireSignedIn()` (not `requireRole`) so it doesn't redirect to itself.
Signing out is still reachable (the header's sign-out action isn't gated).
After the student sets a new password
(`supabase.auth.updateUser({ password })`), the self-only
`clear_must_change_password()` RPC clears the flag — it takes no target id,
so it can only ever clear the caller's own row. The flag itself is protected
by `profiles_guard_update` (extended in `20260705000008`/`20260705000009`)
so that **only** `clear_must_change_password()` or the service role can
touch it — not even a direct PATCH by `super_admin`, since this column gates
which password is currently trusted, not ordinary profile data. (The
service-role carve-out is detected via the request's JWT `role` claim,
`request.jwt.claims ->> 'role' = 'service_role'` — `current_user`/`session_user`
both turned out to be useless for this inside a `security definer` trigger:
`current_user` is always the function owner, and PostgREST's `authenticator`
connection makes `session_user` identical for every request regardless of
which key was used.)

### CSV import with a validation preview

From a class page, **Import students (CSV)** accepts a file with columns
`full_name,index_number,phone` (template download button in the dialog;
`phone` is optional). Parsing/validation
(`apps/web/lib/onboarding/roster-csv.ts`) is dependency-free — a small
RFC-4180-ish parser handling quoted fields, since names can contain commas —
and runs **server-side** on every step (never trust the client's own parsed
preview): `previewRosterImport` re-parses the raw text and flags each row as
ready / duplicate index in the file / bad index format (`^\d{10}$`) /
already enrolled / missing name, and **nothing is created until you
confirm**. `commitRosterImport` re-validates again at commit time, then for
each still-valid row creates-or-finds the student account (idempotent by
index number — re-running the same CSV after fixing one bad row does not
recreate or re-charge a password to already-imported students) and enrolls
it via `enroll_existing_student` (also idempotent —
`ON CONFLICT ON CONSTRAINT ... DO NOTHING`).

### Roster export for mail-merge

After an import (or after using **Reset password** on an existing student),
**Export roster (CSV)** downloads `full_name,index_number,login_url,temp_password`
— built client-side (`lib/onboarding/roster-export.ts`) from whatever temp
passwords are still held in the page's component state. CSV is the required
format (works with Google/Microsoft mail merge with no extra tooling);
**XLSX is intentionally not included** — no spreadsheet library is in this
repo's dependencies and CSV alone already satisfies the mail-merge use case.
Accounts with no freshly generated password in this session show
`(existing — use reset)` instead of a blank cell, so a lecturer never
mistakes "no password shown" for "no password needed." The UI states
explicitly, next to the table, that these values are shown **once**.

### Pluggable SMS adapter

`apps/web/lib/sms/provider.ts` defines `SmsProvider` (`send(to, message)`).
`getSmsProvider()` returns `HubtelSmsProvider`
(`apps/web/lib/sms/hubtel-provider.ts`) only when `HUBTEL_CLIENT_ID`,
`HUBTEL_CLIENT_SECRET`, and `HUBTEL_SENDER` are **all** set in the
environment (see `apps/web/.env.example`); otherwise it falls back to
`LogSmsProvider` (`apps/web/lib/sms/log-provider.ts`) — the default in every
environment today, since USTED has no Hubtel account yet. The log provider
sends nothing; it records (server console) exactly what would have been
sent and returns success, so **Send login details via SMS** in the import
dialog can be demoed end-to-end — each recipient's outcome (sent/recorded,
or "no phone number on file") is shown in the UI. Switching to real delivery
later is a matter of setting the three env vars; no code changes needed.

### Verifying locally

The RLS smoke test's section `(q)` (`scripts/rls-smoke-test.mjs`) covers:
`create_class` is lecturer-or-higher only; a student cannot create a class,
read another class's members, or call `enroll_existing_student` /
`remove_class_member` / `class_roster` on a class they don't own or teach;
enrollment is idempotent; roster-membership RLS returns exactly the caller's
own row; `must_change_password` cannot be set via a direct client PATCH by
anyone (including `super_admin`) — only `clear_must_change_password()` or
the service role; and a full onboarding round trip (service-role account
creation → index-number login resolution → real password sign-in →
self-service flag clear) using the exact synthetic-email scheme
`create-student.ts` uses.

## Question banks & authoring (Phase 3b)

Under **Lecturer dashboard → Question banks**: create a bank, organize it
with a category tree, author questions per type, and bulk-import from
CSV/Aiken/GIFT. This is authoring only — the exam builder (draw/shuffle
from a pool) is Phase 3c and the exam room is Phase 3d; nothing here lets a
student see a bank or a question (RLS grants zero access to any of the four
tables below to the `student` role — exam delivery will expose only the
drawn, sanitized question content through its own RPC, never these tables).

### Schema

`question_banks` (owner + name/description) → `question_categories` (a
self-referencing tree scoped to one bank, `unique(bank_id, parent_id,
name)`) → `questions` (the logical question: type, difficulty, tags,
status, `current_version_id`) → `question_versions` (the actual content).
RLS on all four is owner-or-lecturer-or-higher for manage/select (the same
"any lecturer" simplification as `classes`/`forms_exams` elsewhere in this
codebase — Phase 4 scopes it to ownership/co-teaching) and **zero** rows
for `student`.

### The versioning model — edit = new version

`question_versions` rows are **immutable**: `question_versions_no_update`
(a trigger) plus an explicit `revoke update ... from anon, authenticated`
both block mutating an existing version (belt-and-braces — RLS alone would
have let the UPDATE silently match 0 rows and report success instead of
erroring, which the smoke test caught). "Editing" a question means calling
`add_question_version(question_id, prompt, body)`: it inserts
`version_no = max+1` and repoints `questions.current_version_id` at the new
row — **the old version row stays in the table forever**, addressable by
id. This is why versioning exists at all: once Phase 3c/3d exam attempts
record which exact `version_id` a student was served, that row's wording
can never change under them, even if the question is edited a dozen times
afterward. The authoring UI's edit screen states this plainly ("Saving
creates version N+1 — the old version is kept for any past exam attempts
that already used it") and asks for confirmation before saving.

Category, difficulty, tags, and status are metadata on the `questions` row
itself, not versioned content — they're not part of what an exam attempt
needs to stay faithful to, so they update in place via their own RPCs
(`set_question_status` for retire/reactivate; category/difficulty/tags
editing beyond creation isn't wired to a dedicated RPC in this phase — the
type is locked entirely once created, since draw logic in 3c will assume it
never changes for a given question id).

### Per-type body shapes

Documented as the source of truth on `question_versions`' table comment in
the migration:

| Type | `body` shape |
|---|---|
| `mcq_single` / `mcq_multi` | `{options:[{id,text}], correct:[optionId,...], marks}` — exactly 1 correct id for `mcq_single`, ≥1 for `mcq_multi` |
| `true_false` | `{correct:boolean, marks}` |
| `numeric` | `{correct:number, tolerance:number, marks}` |
| `short_answer` | `{accepted:[string,...], case_sensitive:boolean, marks}` — enables optional auto-grading later |
| `essay` | `{marks, rubric:string}` — always manually graded (Phase 3d) |

`create_question`/`add_question_version` do minimal server-side shape
validation (options present, ≥2 for mcq, marks > 0, numeric fields actually
numeric, etc.) — enough to protect grading integrity, not full pedagogical
review.

### RPCs and why none need the EXECUTE-lockdown pattern

`create_question_bank`, `create_question`, `add_question_version`,
`set_question_status`, `create_question_category`,
`rename_question_category`, `delete_question_category`, and `bank_questions`
are all security-definer with `set search_path = ''`. Unlike
`_create_proctor_session` (20260705000006) or `match_forms_submission`,
**none of these trust a pre-validated payload from another function** —
each one independently re-derives the caller's authority from `auth.uid()`
plus `has_role('lecturer')` or bank ownership (via the shared
`can_manage_question_bank(bank_id)` helper), the same model 3a's
`create_class`/`enroll_existing_student` use. That means a student calling
any of them directly over PostgREST is rejected by the function's own logic,
not by a missing grant — verified by the RLS smoke test's negative-
authorization checks (section `(r)`, e.g. `r1`, `r4`, `r11`, `r17`).

### Authoring UI

A per-type editor (`components/questions/question-editor.tsx`) switches its
fields by `type`: MCQ (dynamic option rows added/removed by button, never
drag — DESIGN.md 2.5.7 — correct answers via radio for single-answer or
checkboxes for multi-answer), true/false (a radio pair), numeric (value +
tolerance), short answer (a list of accepted answers + case-sensitivity
toggle), essay (marks + a rubric textarea). Full a11y: every field has a
visible label, option groups use `fieldset`/`legend`, validation errors
surface as a focus-managed error summary (`role="alert"`) plus the
individual messages, and every save/confirm goes through `notify.*`
(`lib/notify.ts`). The category tree
(`components/questions/category-tree.tsx`) is a plain nested list with
explicit add/rename/delete buttons at every node — fully keyboard-operable,
no drag-and-drop.

### Bulk import — CSV, Aiken, GIFT

One import screen (`components/questions/question-import-form.tsx`) with a
format picker, paste-or-upload, a **preview table before anything is
created**, and a confirm step — same "never trust the client's parsed rows"
posture as the Phase 3a roster importer: `previewQuestionImport` and
`commitQuestionImport` (`app/dashboard/lecturer/question-banks/[id]/import/actions.ts`)
both re-parse the raw text server-side. The three format parsers
(`apps/web/lib/questions/import/{csv,aiken,gift}.ts`) are pure,
dependency-free functions, unit-tested by
`scripts/question-import-parsers.test.mjs` (Node's built-in test runner +
Node 22+'s native TypeScript type-stripping — no vitest/tsx dependency
added to `apps/web`; run via `pnpm test:questions`).

**CSV/TSV** — header `type,prompt,options,correct,difficulty,tags,marks,category`.
`options`/accepted answers are pipe- or semicolon-separated; `correct` is a
1-based index or a letter for MCQ, `true`/`false` for true/false,
`value` or `value:tolerance` for numeric, pipe/semicolon-separated accepted
answers for short answer. `category` is a slash-separated path
(`"Topic/Subtopic"`) — missing categories are created on commit.

**Aiken** — the classic format: a prompt line, `A. `/`B. ` option lines (any
number of options), then `ANSWER: <letter>`. Every item becomes
`mcq_single`; multiple items are separated by blank lines.

**GIFT** — a documented **subset** of Moodle GIFT:

- Supported: `::title::` prefix (stripped), `$CATEGORY:` lines (applies to
  subsequent items until the next one), multiple choice
  `{ =correct ~wrong ~wrong }`, true/false `{TRUE}`/`{FALSE}`/`{T}`/`{F}`,
  short answer `{ =ans1 =ans2 }` (only `=` entries, no `~`), numeric
  `{#answer:tolerance}` or `{#answer}`, `\:` `\~` `\=` `\#` `\{` `\}`
  escapes, `//` line comments.
- **Not** supported, rejected with a clear per-row reason rather than
  silently mis-imported: per-option feedback (`# text` — parsed out and
  discarded, not preserved anywhere in this schema), per-option weights
  (`%50%` — this schema has no partial-credit model for MCQ options),
  matching/Cloze sub-questions, and empty `{}` essay-style items (GIFT's
  essay marker carries no rubric text and this schema requires one — author
  essays via the editor UI or CSV instead).

Every format's preview flags invalid items with a specific reason (e.g. "mcq
questions require at least 2 options", "per-option weights are not
supported") and the confirm button only commits the valid subset — the
result toast reports "Imported N of M; K skipped."

### Verifying locally

The RLS smoke test's section `(r)` (`scripts/rls-smoke-test.mjs`) covers:
`create_question_bank`/`create_question` are lecturer-or-higher only
(student denied); a student cannot `SELECT` `question_banks`/`questions`/
`question_versions`/`question_categories` at all (RLS, not just RPC
gating); `add_question_version` increments `version_no` and repoints
`current_version_id` while the **old version row still exists**
(`r12`–`r14` — the actual versioning guarantee, not just "the new value
stuck"); a version row cannot be `UPDATE`d even by the bank owner (`r15`);
retire/reactivate works; category tree insert + cascade-delete (child
categories cascade, orphaned questions become uncategorized rather than
being deleted, `r18`). Run `node scripts/rls-smoke-test.mjs` (needs the dev
server running for the unrelated Phase 2b webhook checks earlier in the
same script) and `pnpm test:questions` for the parser unit tests.

## Exam builder (Phase 3c)

The exam builder defines exams that draw questions from Phase 3b banks and
attach to a Phase 3a class. It stops at the **definition** of an exam and a
**server-side draw function** for Phase 3d to call at attempt-start — it does
not build the exam room, attempt storage, proctoring integration, or grading.

### Schema

`exams` (`supabase/migrations/20260705000011_exams.sql`) — one row per exam:
`owner_id`, `class_id` (the cohort that may take it; null = not takeable by
any student yet), `status` (`draft`/`published`/`closed`, mirrors
`forms_exams`), `opens_at`/`closes_at`/`duration_minutes`, `integrity_tier`,
`violation_policy` (same shape as `proctor_sessions.violation_policy`,
reusing `ViolationPolicyEditor` wholesale in the builder UI),
`shuffle_questions`/`shuffle_options`, `results_release`.

`exam_sections` — an ordered section within an exam (`unique(exam_id,
ordinal)`; reordered via `reorder_exam_section`'s up/down swap, never
drag-only — DESIGN.md accessibility requirement).

`exam_section_sources` — one row per question SOURCE within a section, not
one row per question. A `CHECK` constraint enforces the right columns per
`source_type`:
- **`fixed`**: pins exactly one `question_id` — the same wording every
  attempt (subject only to option shuffling).
- **`pool`**: `bank_id` + optional `category_id`/`difficulty`/`tags` +
  `draw_count` — that many **active** matching questions are drawn
  pseudo-randomly per attempt. A section may freely mix fixed and pool
  sources.

### Fixed vs pool draw, and the per-attempt seeded randomization

Per-student randomized draw is a core anti-cheat layer (`docs/RESEARCH.md`
§4): every student who opens the same exam can get a different set of
pool-drawn questions and a different option order, while grading and
after-the-fact audit still need to reproduce **exactly** what a given
student was shown. The design resolves that tension with **deterministic
seeding** rather than true randomness: `draw_exam_for_attempt(exam_id,
seed)` orders candidates by `md5(seed || ...)` — same `(exam_id, seed)`
always returns the identical question set and order; a different seed
(one per attempt, assigned by Phase 3d) almost always produces a different
one. `current_version_id` is resolved and embedded **at call time**
("frozen") — a later edit to a question (`add_question_version`) never
retroactively changes an already-drawn attempt, because the attempt's
recorded `version_id` is a specific immutable row, not the mutable
`current_version_id` pointer.

`draw_exam_for_attempt` returns the **full frozen structure including
correct answers** — Phase 3d is expected to store that server-side and
serve the student only a sanitized view with no `correct` fields.

### Why the draw function is locked down

Because `draw_exam_for_attempt` returns correct answers, it must never be
directly reachable by a client. `EXECUTE` is revoked from
`public`/`anon`/`authenticated` immediately after creation — the exact
same lock-down pattern as `_create_proctor_session`
(`20260705000006_lock_down_create_proctor_session_helper.sql`). It stays
reachable by:
- The **service role** (Phase 3d's future attempt-creation code — the
  smoke test's determinism/retired-exclusion/frozen-version proofs call it
  this way, mirroring how Phase 3d is expected to call it).
- **`preview_exam_draw`**, a `SECURITY DEFINER` wrapper that independently
  re-derives "is this caller the owner or a lecturer" via `can_manage_exam`
  before delegating — a direct student RPC call to either function fails
  with a clean `permission denied for function` / an authority-check
  exception, not a business-logic error.

Every other RPC in the migration (`create_exam`, `update_exam`,
`add_exam_section`, `reorder_exam_section`, `add_section_source`,
`validate_exam`, `set_exam_status`, ...) re-derives authority from
`auth.uid()` + `has_role()`/`can_manage_exam()`/`can_manage_question_bank()`
themselves, exactly like 3a/3b's RPCs — none of them trust a client-supplied
claim, so none of them need the lock-down treatment.

### Validation-gated publish

`validate_exam(exam_id)` checks: every section has at least one source,
every pool source has enough **active** matching questions for its
`draw_count`, every fixed source still points at an active question, and a
class is assigned. It returns `{ok, issues: string[]}`. `set_exam_status`
calls `validate_exam` before allowing a transition to `published` and
raises with the full issue list if not `ok` — publishing is only possible
through this one RPC, so this is a real enforcement point, not just a UI
nicety.

### Student visibility is class-scoped

Students get **no** `SELECT` policy at all on `exam_sections` or
`exam_section_sources` — even for a published, in-window exam they can see,
a direct client query on either table returns zero rows. The one student
policy on `exams` itself requires **all** of: `status = 'published'`,
`now()` inside `[opens_at, closes_at]` (nulls unbounded), and a
`class_members` row for that student and the exam's `class_id`. Reassigning
a published exam to a different class immediately revokes visibility for
students not enrolled in the new class (verified in the smoke test, `s21`).

### Verifying locally

The RLS smoke test's section `(s)` covers: `create_exam` is
lecturer-or-higher only; a student cannot see a draft exam nor any
sections/sources; a student sees a published+open exam for a class they are
enrolled in but not one for a class they are not; `validate_exam` catches
an under-filled pool and blocks publish via `set_exam_status`; **both** a
student's and the owning lecturer's own direct `draw_exam_for_attempt` RPC
call are denied (lock-down regression, `s22`); `preview_exam_draw` is
owner/lecturer-only; same-seed determinism, distinct selections across
different seeds, retired-question exclusion, and frozen-version proofs
(`s25`–`s28`). Run `node scripts/rls-smoke-test.mjs` (dev server must be
running for the unrelated Phase 2b webhook checks earlier in the script).

### What's deferred to Phase 3d

Attempt-taking, per-student attempt records, answer storage,
autosave/resume, the server-authoritative timer, auto-grading, the manual
grading queue, results release logic, and attaching the proctoring engine
by tier are all out of scope here — see "Exam room & attempts (Phase 3d-i)"
below for the part of this list that Phase 3d-i now delivers.

## Exam room & attempts (Phase 3d-i)

Phase 3d-i is the **secure exam-taking spine**: the attempt lifecycle, a
frozen per-attempt paper, sanitized one-question-at-a-time delivery,
autosave, resume-on-disconnect, a server-authoritative timer (with
accommodations extra-time), submission, and auto-grading of objective
question types. This is the T1 (server-side-anti-cheat-only) exam room —
webcam/proctor-core attachment, manual essay grading, and a dedicated
student results view are **Phase 3d-ii**, which will wrap this room rather
than replace it.

### Schema: attempts, the frozen paper, and answers

`supabase/migrations/20260705000012_exam_attempts.sql` adds three tables:

- **`exam_attempts`** — one row per student attempt: `status`
  (`in_progress` → `submitted`/`auto_submitted`; `graded`/`terminated`
  reserved for Phase 3d-ii), `seed`, `started_at`/`deadline_at`,
  `submitted_at`, `auto_score`/`max_score`, `needs_manual_grading`. Carries
  **no question content or answers** — only lifecycle/timing/score state —
  so it is safe to expose to the owning student via an ordinary RLS SELECT
  policy (`student_id = auth.uid()`) plus the exam's owner/lecturer-or-higher
  (read-only, for Phase 3d-ii grading tools). A unique partial index allows
  at most one `in_progress` row per `(exam_id, student_id)`.
- **`exam_attempt_papers`** — `attempt_id` → `frozen_paper` jsonb, the FULL
  `draw_exam_for_attempt()` output verbatim, correct/accepted/tolerance/
  rubric fields included. **This table has RLS enabled + forced with ZERO
  policies for any client role, not even the owning student.** A direct
  `.from("exam_attempt_papers").select()` from any authenticated or anon
  client returns zero rows unconditionally — this is the load-bearing
  security property of the whole migration (see "Answers never reach the
  client" below).
- **`exam_answers`** — one row per `(attempt_id, question_ref)`: the
  student's own response (`jsonb`, shape varies by question type) and
  `flagged`. `question_ref` is a per-slot id minted as
  `"<section_id>:<index>"` when the paper is frozen, not the raw
  `question_version_id` — a pool draw can only place a given version once
  per section today, but slots (not versions) are the addressable unit
  autosave targets, so a future looser pool config can't retroactively
  break this. RLS: owner or the exam's owner/lecturer-or-higher may SELECT;
  no client INSERT/UPDATE/DELETE at all — every write goes through
  `save_exam_answer` (below).

**Re-attempt policy** (documented simplification): one attempt per student
per exam. `start_exam_attempt` resumes an `in_progress` attempt if one
exists; otherwise it refuses if ANY prior attempt (terminal or not) already
exists for that `(exam, student)` pair. A future `max_attempts` column can
relax this without a schema rewrite.

### Answers never reach the client

This is the single most important property of this phase. Three
independent layers enforce it:

1. **Storage separation** — the frozen paper (with answers) lives only in
   `exam_attempt_papers`, which has no client-reachable SELECT policy at
   all. `exam_attempts`/`exam_answers`, which the student CAN read, never
   contain question content.
2. **Server-side stripping** — `get_attempt_questions(attempt_id)` is the
   *only* way a student sees their questions. It reads the frozen paper
   internally (as the security-definer function owner, which is not
   subject to `exam_attempt_papers`' policy-less FORCE RLS the way a normal
   client session is) and returns a rebuilt JSON structure with
   `body.correct` / `body.accepted` / `body.case_sensitive` /
   `body.tolerance` / `body.rubric` removed and `options` rebuilt as bare
   `{id, text}` pairs — never a filtered pass-through of the original body.
3. **Results-release gating** — `submit_exam_attempt` auto-grades
   server-side and returns per-question correctness (`per_question` in its
   response) *only* when `exams.results_release = 'immediate'`; for
   `after_close`/`manual` it returns totals/ack only (`per_question: null`),
   so a curious student can't infer which answers were right from the
   submit response itself.

`draw_exam_for_attempt` (Phase 3c, already locked down — `EXECUTE` revoked
from `public`/`anon`/`authenticated`) is called *only* from
`start_exam_attempt`, itself `security definer`; a client can never reach
it directly, exactly as before. `grade_objective_slot` (new in this
migration) is answer-adjacent — it grades whatever `(type, body, response)`
it's handed with no `auth.uid()` check of its own — so it gets the same
lock-down treatment: `EXECUTE` revoked from `public`/`anon`/`authenticated`
immediately after creation, callable only from `submit_exam_attempt`.

### RPCs

- **`start_exam_attempt(exam_id, claimed_index_number, attested)`** —
  validates enrollment (`class_members`), `exams.status = 'published'`,
  `now()` within `[opens_at, closes_at]`, and `attested = true` (the same
  identity-gate spirit as `start_proctor_session`). Resumes an existing
  `in_progress` attempt if found; otherwise generates a seed, calls
  `draw_exam_for_attempt`, mints `question_ref` per slot, computes
  `deadline_at` from `exams.duration_minutes` scaled by the caller's
  `profiles.accommodations->>'extra_time_multiplier'` (default `1.0`; a
  `null` duration means no time limit, represented as a far-future
  deadline rather than a nullable column), and stores the frozen paper.
- **`get_attempt_questions(attempt_id)`** — owner-only sanitized delivery
  (see above). Also returns the student's saved responses/flags and
  `deadline_at` + server `now()`, so the client can render resume state and
  synchronize its countdown to the *server's* clock, never the browser's.
- **`save_exam_answer(attempt_id, question_ref, response, flagged)`** —
  autosave. Owner-only, attempt must be `in_progress`, and — the
  server-authoritative deadline enforcement — refuses any save once
  `now() > deadline_at`, regardless of what the client believes the time
  remaining is. Upserts on `(attempt_id, question_ref)`.
- **`submit_exam_attempt(attempt_id)`** — owner-only; allowed even slightly
  past `deadline_at` (recorded as `auto_submitted` instead of `submitted`,
  so a student mid-keystroke when the clock hits zero can still submit).
  Auto-grades every non-essay slot via `grade_objective_slot`: `mcq_single`
  (exact option match), `mcq_multi` (exact set match — **no partial
  credit**, documented), `true_false`, `numeric` (within `|tolerance|`),
  `short_answer` (any accepted string, case-insensitive unless
  `body.case_sensitive`). Essay slots set `needs_manual_grading = true` and
  score 0 (graded in Phase 3d-ii). Stores `auto_score`/`max_score` and
  gates `per_question` by `results_release` (see above).

No standing scheduler auto-submits abandoned attempts — deadline
enforcement is lazy (refuse late saves; treat a late submit as
`auto_submitted`) by design for this phase; a cron/edge sweep for genuinely
abandoned attempts is a documented TODO for Phase 3d-ii/Phase 6.

### The exam room UI

`apps/web/app/exam/[examId]/page.tsx` → `ExamAttemptWrapper` →
`ExamAttemptIntro` (a short "this is a timed exam, answers autosave, don't
navigate away" notice + the same index-number/attestation pattern as the
proctoring identity step, minus the camera — that's Phase 3d-ii) →
`start_exam_attempt` + `get_attempt_questions` → `ExamRoom`.

`ExamRoom` (`apps/web/components/exam-room/exam-room.tsx`) mirrors
`components/proctor/sample-quiz.tsx`'s one-question-at-a-time + palette +
flag-for-review + review-before-submit UX, backed by the real RPCs:

- **Autosave**: every answer/flag change is debounced (900ms) and sent via
  `save_exam_answer`, with a visible "Saved HH:MM:SS" indicator
  (`aria-live="polite"`, DESIGN.md §2.1).
- **Resume**: on load, `get_attempt_questions` returns saved
  responses/flags, which seed the room's state — reloading mid-exam
  restores exactly where the student left off (verified in the browser
  check below).
- **Server-authoritative timer**: the client measures a one-time
  offset between its own clock and the server's `now()` (from
  `get_attempt_questions`), then always derives "time remaining" from
  `deadline_at - (Date.now() + offset)` — a wrong local clock can't produce
  an incorrect countdown. Announces at 30/15/5/1 minutes remaining via an
  `aria-live="polite"` region (DESIGN.md §3 Robust) and auto-submits at
  zero.
- **Calm reconnect**: a failed autosave buffers the answer locally and
  shows "Reconnecting… your answers are saved on this device" — never an
  alarming error — and flushes automatically on the browser's `online`
  event or a 5s retry poll (DESIGN.md §2.6).
- **Review-before-submit**: submitting lists unanswered question numbers
  via `notify.confirm()` before proceeding, exactly like the sample quiz.
- **Results**: the post-submit screen shows the score immediately when
  `results_released = true` (from `submit_exam_attempt`'s response),
  otherwise a "results will be available later" message.

### Accommodations extra-time

`profiles.accommodations->>'extra_time_multiplier'` (e.g. `1.25`, `1.5`,
`2`) is read once, at `start_exam_attempt` time, and multiplies
`exams.duration_minutes` when computing `deadline_at`. This is a first-class
exam-engine feature per DESIGN.md §3 "Timing adjustable," not a
workaround — an admin sets the multiplier on the student's profile, and
every future exam that student takes honors it automatically.

### Verifying locally

The RLS smoke test's section `(t)` covers the full attempt lifecycle:
`start_exam_attempt` succeeds when enrolled+published+open+attested and is
denied for not-enrolled/draft/closed/out-of-window/unattested; a second
call **resumes** the same attempt (no duplicate row); the **answer-leak
regression** — a student cannot read `exam_attempt_papers` directly at all,
`get_attempt_questions`' sanitized JSON is scanned recursively and contains
none of `correct`/`accepted`/`case_sensitive`/`tolerance`/`rubric`
anywhere, and cross-attempt ownership is schema-verified; `save_exam_answer`
is refused for a non-owned attempt and once past a (test-forced)
`deadline_at`; `submit_exam_attempt` auto-grades a mixed right/wrong
six-type submission to the exact expected score, sets
`needs_manual_grading` for the essay slot without leaking its rubric, and
gates per-question correctness by `results_release`
(`after_close` hides it, `immediate` reveals it); and the accommodations
`extra_time_multiplier` measurably extends `deadline_at`. Run
`node scripts/rls-smoke-test.mjs` (dev server must be running for the
unrelated Phase 2b webhook checks earlier in the script).

## Proctored exams, grading & results (Phase 3d-ii)

Phase 3d-ii attaches the real proctoring engine to the Phase 3d-i exam room
**by tier**, ties a proctor session's server-decided termination to the
exam attempt (tamper-proof — no client cooperation needed), adds manual
essay grading + finalization, and results-release gating including the one
RPC that may ever hand a student a correct answer. It reuses every Phase
1/2 proctoring building block (`ConsentScreen`, `IdentityCheck`,
`proctor-core`'s engine, the Supabase adapters, MediaPipe face detection) —
nothing proctoring-related was reinvented for this phase. The full Phase 4
review workspace (video timeline, per-flag reviewer verdicts, student
appeals) is **not** built here; this phase only surfaces an integrity
summary (violation count, session status, whether a `proctor_reports` row
exists) plus a handle to the session id.

`supabase/migrations/20260705000013_proctored_exams_grading.sql` is the
migration for all of the below.

### Tier-based proctoring attachment

`exam_attempts.proctor_session_id` links an attempt to a `proctor_sessions`
row. `start_exam_attempt` (rewritten, same signature) now checks the
**exam's own** `integrity_tier`:

- **Tier 1**: unchanged from 3d-i. No session, no camera — server-side
  anti-cheat only (randomization, timing, session/window checks).
- **Tier 2+**: after creating the attempt, calls the same internal
  `_create_proctor_session(context, tier, policy, claimed_index, attested)`
  helper the Phase 2a Forms wrapper uses (`20260705000005`/`000006`,
  already locked down — `EXECUTE` revoked from `public`/`anon`/
  `authenticated`, reachable only through a security-definer entry point),
  passing the **exam's** `integrity_tier` + `violation_policy` —
  `start_exam_attempt` has no tier/policy parameter for the client to
  override, the same structural guarantee `start_forms_exam_session` relies
  on. `context = 'exam:' || attempt_id` (attempt-scoped, since each attempt
  is its own proctored session, distinct from the Forms wrapper's
  `'form:' || forms_exam_id`). The new session id is stored on
  `exam_attempts.proctor_session_id` and returned to the client via
  `get_attempt_questions` (also newly returns `integrity_tier`), so the
  exam room knows whether to run the engine and — on a page-refresh resume
  — which existing session to reattach to rather than minting a second one.

### Exam room wiring (`apps/web/components/exam-room/`)

`ExamAttemptWrapper` now branches on `exam.integrity_tier` fetched
server-side with the exam row (never chosen client-side):

- **Tier 1**: identical to 3d-i — `ExamAttemptIntro` → `start_exam_attempt`
  → `get_attempt_questions` → the plain `ExamRoom`.
- **Tier 2+**: `ConsentScreen` → `IdentityCheck` (index number + portrait +
  attestation, reusing the Phase 1.5/2a component verbatim, including its
  Phase 1.6 portrait-quality gate) → `start_exam_attempt` (now also starts
  the linked session) → `get_attempt_questions` → **`ProctoredExamRoom`**
  (new), which wraps the unmodified `ExamRoom` with:
  - `createProctorEngine` from `@proctor/core`, started against the
    server-created session (never a client-chosen tier/policy), using the
    same `createSupabaseTransportAdapter` / `createMediaPipeFaceDetectorAdapter`
    the Forms wrapper and proctoring demo use.
  - A monitoring panel (live event feed + recent snapshot thumbnails,
    `<details>`-collapsible) reusing `components/proctor/event-feed.tsx`.
  - A "Proctoring active — tier N · strikes X of Y" status strip, live via
    `engine.onViolationUpdate`.
  - `engine.onTerminated` — fired when the *server's* response to a batched
    event upload reports `session_status: 'terminated'` — stops local
    collection, calls `notify.error` with calm wording ("Session ended:
    violation limit reached" / "Your attempt was submitted for review — no
    automatic penalty"), and renders a locked summary card. By the time
    this fires the attempt is **already** closed server-side (see below);
    the client is only catching up to a fact the database already recorded.
  - Fullscreen/tab/clipboard/display-change collectors run automatically —
    `proctor-core`'s `start()` wires them unconditionally; nothing new was
    needed here for T3+, since the collectors and `defaultSeverity(event,
    tier)` already exist from Phase 1/1.7.
  - Accessibility: accommodations continue to suppress/annotate AT-triggered
    false flags at the **server** severity-assignment layer
    (`log_proctor_events`, unchanged) — this phase adds no new client-side
    hard-fail path for AT users. `notify.examWarning` (never the alarming
    "error" red) is used for every in-session integrity toast.
  - Honest limitation: on a page-refresh **resume**, there is no webcam
    stream to reuse (it was only ever handed off once, during identity
    verification, in the same browser session) — the panel says so plainly
    ("Camera not reattached after resume — non-camera monitoring is still
    active") rather than silently doing nothing. All non-camera signals
    (fullscreen, tab, clipboard, connection, display-change) still run.

### Server-side termination tie (the tamper-proof part)

`log_proctor_events` (Phase 1.7, unchanged) already terminates a session
server-side and files a `proctor_reports` row when `violation_count`
reaches `violation_limit` — entirely from server-assigned severity, never
trusting the client. This phase adds a **trigger**,
`sync_exam_attempt_on_proctor_termination`, `AFTER UPDATE ON
proctor_sessions`: when a session's `status` transitions into `terminated`
or `abandoned` and its `context` matches `'exam:%'`, it finds the linked
`in_progress` `exam_attempts` row (via `proctor_session_id`) and, in the
same transaction:

1. Re-grades every objective slot answered so far by reusing
   `grade_objective_slot` (the same locked-down helper `submit_exam_attempt`
   calls) — essay slots contribute 0 and set `needs_manual_grading`.
2. Sets `status = 'terminated'`, `submitted_at = now()`,
   `auto_score`/`max_score`/`needs_manual_grading` accordingly.
3. Audit-logs `proctor_termination_closed_attempt`.

No client call is involved anywhere in this path — a student who hits the
violation limit has their attempt closed and partially graded purely as a
side effect of the server processing their own (or the last) batched event
upload. The trigger no-ops if no matching `in_progress` attempt is found
(e.g. the student had already submitted normally through
`submit_exam_attempt`, which ends the session via `end_proctor_session`
with `status='ended'`, a status this trigger deliberately ignores).

### Manual essay grading

- **`grade_essay_slot(attempt_id, question_ref, marks_awarded, feedback)`**
  — owner/lecturer-or-higher only (re-derived via `can_manage_exam`, never
  trusting a client claim), only for `essay`-type slots of a
  submitted/auto_submitted/terminated/graded attempt. Re-derives the slot's
  real max marks from the frozen paper (never a client-supplied max) and
  **clamps** `marks_awarded` to `[0, slot marks]` rather than rejecting an
  out-of-range value. Stores the grade + optional feedback in two new
  `exam_answers` columns (`marks_awarded`, `feedback`). Auto-calls
  `finalize_attempt_grade` once every essay slot in the paper has a grade,
  so grading every essay in one sitting needs no separate "finalize" click.
- **`finalize_attempt_grade(attempt_id)`** — recomputes
  `auto_score = (the objective auto_score already stored) + sum(graded
  essay marks_awarded)`, sets `status = 'graded'`,
  `needs_manual_grading = false`. Owner/lecturer-or-higher only, idempotent,
  independently callable (e.g. to finalize with a no-show essay left
  ungraded at 0).
- **`get_attempt_for_grading(attempt_id)`** — the lecturer-facing detail RPC
  the grading UI reads: every slot's prompt + the student's response, plus
  (for essays) the **rubric** + current `marks_awarded`/`feedback`, and
  (for objective types) the auto-computed score for reference. Owner/
  lecturer-or-higher only, **not** release-gated (a lecturer must be able
  to grade before releasing) and never student-reachable — distinct from
  both `get_attempt_result` (student-only, release-gated, no rubric) and
  `exam_results` (summary only, no question content).

UI: `apps/web/app/dashboard/lecturer/exams/[id]/grade/[attemptId]/page.tsx`
+ `components/exams/essay-grading-form.tsx` — one accessible marks input
(0..max) + feedback textarea per essay, a "Save grade" button per slot, and
a "Finalize grade" button.

### Results release gating + the one answer-revealing path

`exams` gains `results_released_at` (set only by `release_exam_results`,
for `results_release = 'manual'` exams). Release logic, applied
consistently everywhere results are read:

| `results_release` | Released when |
|---|---|
| `immediate` | Always, once submitted (unchanged from 3d-i) |
| `after_close` | `now() > closes_at` **or** the lecturer has set `status = 'closed'` |
| `manual` | `exams.results_released_at is not null` |

- **`release_exam_results(exam_id)`** — owner/lecturer-or-higher only;
  raises for any exam whose `results_release` isn't `'manual'` (the other
  two release automatically, there is nothing to "click").
- **`get_attempt_result(attempt_id)`** — **the one and only place in the
  entire schema a correct answer may reach a student.** Owner-only
  (`auth.uid()` must be the attempt's `student_id` — never another
  student's result, proven by a negative smoke-test call from a different
  role). Before release: `{released: false, reason: 'not_submitted' |
  'not_yet_released'}`, nothing answer-adjacent leaves the function. After
  release: total score + a per-question breakdown — the student's own
  response, the correct/accepted answer (plus a bare `{id,text}` options
  list so the client can render "Accra" instead of a raw option id),
  marks earned/available for objective types, and
  `marks_awarded`/`feedback`/`needs_manual_grading` for essays.
- **`exam_results(exam_id)`** — the lecturer results/integrity-summary RPC:
  one row per attempt with student identity, grading state
  (`status`/`auto_score`/`max_score`/`needs_manual_grading`), and — for
  tier≥2 attempts — the linked session's `violation_count`/
  `violation_limit`/`session_status`/`has_report` (a plain boolean, not the
  report content). Owner/lecturer-or-higher only.

UI: `apps/web/app/dashboard/lecturer/exams/[id]/results/page.tsx` +
`components/exams/exam-results-table.tsx` (status/score/needs-grading
badges + the integrity column) + `components/exams/release-results-button.tsx`
(only rendered for `results_release = 'manual'` exams, `notify.confirm`
gated). Student side: `apps/web/app/exam/attempt/[attemptId]/result/page.tsx`
+ `components/exams/attempt-result-view.tsx` (a friendly "not yet released"
state, or the full breakdown once released) and
`components/exams/my-results-list.tsx` on the student dashboard (every
attempt past `in_progress`, linking to its result page — the list itself
shows no score, only status, since release-gating happens per-attempt on
the result page).

### Locked-down / re-derived-authority helpers introduced this phase

Same posture as every prior migration — nothing here trusts a client
argument for authority or answer content:

- `grade_essay_slot`, `finalize_attempt_grade`, `release_exam_results`,
  `get_attempt_for_grading`, `exam_results` — all re-derive
  owner-or-lecturer-or-higher via `can_manage_exam(exam_id)`, independently
  of any client claim.
- `get_attempt_result` re-derives ownership via `auth.uid() =
  exam_attempts.student_id`.
- `sync_exam_attempt_on_proctor_termination` is a trigger function — not
  RPC-callable by any role at all (Postgres trigger functions can't be
  invoked outside their trigger context), so there is no lockdown grant to
  revoke; it is inherently unreachable except by the `UPDATE` on
  `proctor_sessions` that fires it.
- `grade_objective_slot` (Phase 3d-i, answer-adjacent, already
  `EXECUTE`-revoked from `public`/`anon`/`authenticated`) is reused by both
  `submit_exam_attempt` and the new termination trigger — re-verified still
  locked down after this migration (smoke test `u18`).

### Verifying locally

The RLS smoke test's section `(u)` (18 checks) covers: T1 creates no
proctor session while T2 creates one using the **exam's** tier+policy
(verified byte-for-byte against the exam row, never a client-supplied
value); driving the linked session to its violation limit (via
`log_proctor_events`, called as the student/session-owner — the *only*
client action in the whole flow) terminates **both** the session and the
`exam_attempts` row (`status='terminated'`, `submitted_at` set, the
objective slot answered beforehand graded, essay slot flagged
`needs_manual_grading`) with no separate client call; `grade_essay_slot` is
denied to a student, rejects a non-essay slot, clamps an out-of-range mark
to the slot's real maximum, and auto-finalizes to the correct total;
`get_attempt_result` hides results for `after_close` before close and for
`manual` before release, reveals them correctly afterward (including the
resolved option text), and is denied to a non-owning caller; and
`exam_results` is denied to a student. Run
`node scripts/rls-smoke-test.mjs` (dev server running, for the Phase 2b
webhook checks earlier in the script).

A manual browser pass (documented in this phase's implementation notes):
as a lecturer, create a T2 exam (essay + mcq, manual release) on an
enrolled class and publish it; as the student, go through consent →
identity (a synthetic canvas-drawn "face" — a real face is not otherwise
available in a headless verification session, and MediaPipe's BlazeFace
model correctly rejected a plain shape before a face-like image was
supplied, confirming the Phase 1.6 quality gate is doing real work) →
take the exam with the monitoring panel visible, live strike counter, and
autosave → submit; as the lecturer, see the attempt in results with its
integrity summary, grade the essay (rubric visible only to staff, marks
clamped), see the total recompute and status flip to `graded`, and release
results; as the student, see the released result with the full
per-question breakdown. Separately, forcing enough `tab_hidden` events
through the live session to reach the violation limit produced the calm
termination screen client-side **and** an independently-verified
server-side `exam_attempts.status = 'terminated'` with `submitted_at` set
and a `proctor_reports` row — with no submit call ever issued by the
client.

### Deferred to Phase 4

The full proctoring **review workspace** — a video/snapshot timeline with
clickable flag markers, a per-flag human verdict, a session-level
pass/escalate/violation decision, and the student **appeals** flow — is
explicitly out of scope for 3d-ii. Today a lecturer sees only: whether a
`proctor_reports` row exists (`has_report`), the session's final
`violation_count`/`violation_limit`/`status`, and can open Studio directly
against the `proctor_session_id` for the raw event/snapshot history. Also
deferred: re-attaching a webcam stream on page-refresh resume (see "Exam
room wiring" above), and a standing scheduler for genuinely abandoned
attempts (still lazy-enforced, per 3d-i).

## Admin & super-admin consoles

Three screens turn the previously-placeholder admin/super-admin dashboards
into working shells, gated by `requireRole()` (UI-level routing — the real
enforcement is always the RLS/RPC layer described below).

### Users & roles (`/dashboard/users`, admin + super_admin)

Lists every account: `full_name`, email, role, `student_number`, and
whether the account still has to change its temp password.
`profiles` has no email column — the page's data path
(`lib/admin/users.ts#listUsersWithEmail`) reads `profiles` through the
caller's own authenticated client (RLS-scoped: `profiles_select_admin_or_higher`
lets admin/super_admin see every row; anyone else silently gets only their
own row back, so the page degrades safely even if a future caller forgets
the `requireRole` gate) and merges in emails via the **service-role** Admin
API (`admin.auth.admin.listUsers()`, paginated) — server-only, never sent
to the browser as raw service-role data beyond the resolved email string.

- **Role changes** go through the `set_user_role` RPC only —
  `apps/web/app/dashboard/users/actions.ts#changeUserRole` never writes
  `profiles.role` directly. Every escalation rule (nobody changes their own
  role; only `super_admin` grants/revokes `admin`/`super_admin`; `admin` may
  only set `lecturer`/`student`) is enforced in Postgres
  (`set_user_role` in `20260704000005_rls_policies.sql`); the UI
  (`components/admin/users-table.tsx#assignableRoles`) mirrors those same
  rules only to decide what to render (an editable `<select>` vs. a disabled
  badge with a tooltip explaining why), so a client bug in the UI can never
  grant more than the RPC allows. Every change is confirmed via
  `notify.confirm` and audit-logged automatically by the RPC.
- **Accommodations** (extra-time multiplier, AT-flag suppression, reviewer
  notes — DESIGN.md §3) are edited in an accessible dialog and saved via
  the caller's own authenticated client, relying on
  `profiles_update_admin_or_higher` + the `profiles_guard_update` trigger:
  admin/super_admin may update any row's `accommodations`, and that same
  trigger still blocks `full_name`/`student_number`/`role` from changing
  through this path.
- The table uses semantic `<th scope="col">` headers, 44px-minimum controls,
  and a horizontal-scroll container around the table body so it never
  overflows the page at 375px (verified).

### Account lifecycle: suspend, remove, permanently delete

`profiles.status` adds a three-state lifecycle on top of role, so an account
can be disabled without touching its role or deleting its history:

| Status | Meaning | Reversible? |
|---|---|---|
| `active` | Normal — the default | — |
| `suspended` | Reversible disable — blocked from signing in, nothing deleted | Yes, back to `active` |
| `removed` | Soft delete — archived: blocked, but every record (attempts, proctoring sessions, class enrollment) is kept | Yes, back to `active` |

**Permanent delete** is a separate, fourth action (not a `status` value): it
hard-deletes the `auth.users` row via the Admin API, cascading to `profiles`
and everything that references it. It is **super_admin only** and never
offered against another `super_admin` or the caller's own account.

**Permission matrix** — who may change whose status, enforced entirely
inside `set_account_status`
(`supabase/migrations/20260711000001_account_lifecycle.sql`), mirroring
`set_user_role`'s escalation rules:

| Caller | May act on | Notes |
|---|---|---|
| `super_admin` | `admin`, `lecturer`, `student` | never another `super_admin`, never self |
| `admin` | `lecturer`, `student` | never `admin`/`super_admin`, never self |
| `lecturer` | `student` **only** | only a student enrolled in a class the lecturer **owns** (`classes.owner_id = auth.uid()`) — re-checked with a live `exists (... class_members ...)` query, not trusted from the caller; never self |

`status` is gated behind its own transaction-local
`usted.allow_status_change` GUC in `profiles_guard_update`, flipped only by
`set_account_status` around its own `UPDATE` — the exact same pattern
`usted.allow_role_change` uses for `role`. This closes a real hole: without
it, RLS's `profiles_update_own` policy would let a user PATCH their *own*
`status` back to `active` directly via PostgREST, or let super_admin's "any
column" carve-out silently include `status`. Neither is possible — checked
*before* the super_admin passthrough, so not even `super_admin` can
direct-PATCH `status`, only via the RPC. Every change is audit-logged with
`{old_status, new_status}`.

**Login + session enforcement**: `app/login/actions.ts#signIn` checks
`profiles.status` immediately after a successful password check — a
non-`active` account is signed back out on the spot and shown "Your account
has been suspended. Please contact your administrator." (or the "removed"
equivalent), so a blocked account can never complete login even for one
request. `lib/auth.ts#getSessionProfile` performs the same check on every
subsequent navigation, so a user suspended/removed mid-session is bounced to
`/login` the next time `requireRole` runs — both are UI-layer routing; RLS
plus every RPC re-deriving authority from `auth.uid()` remain the actual
security boundary regardless.

**UI**: the Users & roles table gained a Status column (icon + text badge —
Active/Suspended/Removed, never color alone) and a per-row Actions menu
(shadcn `DropdownMenu`) offering Suspend/Reactivate/Remove, gated by
`lib/admin/role-labels.ts#canActOnAccountRole` (the role axis of the
matrix — shared with the class roster below) plus a "not self" check; only
`super_admin` additionally sees "Permanently delete", with a `notify.confirm`
spelling out that it erases the account's exam records and cannot be
undone. A lecturer's own class roster (`components/onboarding/class-detail.tsx`)
gained the same three actions per student, labeled distinctly from the
pre-existing "Remove from class" (unenroll — the account is untouched)
action; they're only rendered when the viewer is admin/super_admin or a
lecturer who owns that class (`page.tsx` computes this from `classes.owner_id`),
so a lecturer never sees a control against a roster they can view (per the
"any lecturer can see any roster" simplification) but don't own — the RPC
enforces the real ownership check regardless.

### Audit log (`/dashboard/audit`, admin + super_admin)

Paginated (50/page), newest-first browser over `audit_log` — the flagship
super-admin oversight screen. Read-only and append-only: the table has no
UPDATE/DELETE grants and a trigger that rejects both outright (see
`20260704000002_audit_log.sql`), so there is no write/delete path to add
here even by accident. `audit_log_select_admin_or_higher` restricts SELECT
to admin-or-higher — a lecturer or student hitting this route's data path
directly gets 0 rows (confirmed in the RLS smoke test, section `v`). Each
row shows time, actor (resolved to name/email the same way as the Users
page), action, target, IP, and an expandable `metadata` viewer. Filterable
by action; the actor list for a page of 50 rows is resolved with at most 50
service-role lookups, not the whole user base.

### System overview (`/dashboard/system`, super_admin only)

Real, live counts — users by role, classes, question banks, questions,
exams by status, exam attempts by status, proctoring sessions by status,
pending proctor reports, and proctoring media files — computed with the
service-role client (`createAdminClient()`) rather than the caller's RLS-
scoped client, because several of the underlying tables (`exams`,
`exam_attempts`, ...) use owner-or-lecturer SELECT policies that would
under-count for a `super_admin` viewer who isn't literally the row's owner.
Also shows the `keepalive` table's last ping and how long ago that was.

**Storage/quota is intentionally honest, not simulated**: Supabase and
Cloudflare R2 free-tier usage (database size, storage, bandwidth) requires
each provider's own management API, which this app does not call. Rather
than fabricate a number, the page states that plainly and links out to the
Supabase project dashboard and the Cloudflare R2 overview, both marked as
"checked in the provider console."

### Dashboard wiring

`/dashboard/admin` and `/dashboard/super-admin` no longer show dead
placeholder cards — every card is a real link. Admin sees Classes, Users &
roles, and Audit log. Super admin sees the same oversight set plus System
overview, and (since `super_admin` is a universal role) a second section
linking straight into every lecturer tool (classes, question banks, Forms
quizzes, exam builder).

### Verifying locally

`node scripts/rls-smoke-test.mjs` section `v` covers: a lecturer/student
cannot read `audit_log` (0 rows, not an error — RLS filters silently, same
as every other admin-gated table here); an `admin` cannot promote anyone to
`admin`/`super_admin` via `set_user_role` (only `super_admin` can); the
Users & roles data path (`profiles` select-all) is confirmed admin-only;
accommodations updates via the admin-or-higher policy persist the exact
`{extra_time_multiplier, suppress_at_flags, notes}` shape the dialog
writes; and a `lecturer` cannot update another user's `accommodations`
(0 rows affected, value unchanged — PostgREST doesn't raise for this case,
it just filters the UPDATE's matched rows via RLS).

Section `z` covers the account-lifecycle permission matrix against
`set_account_status`: a `lecturer` CAN suspend a student enrolled in a class
they own, but CANNOT suspend a student outside their class or a
lecturer/admin/super_admin account; an `admin` CAN suspend a
lecturer/student but CANNOT act on another `admin` or a `super_admin`; a
`super_admin` CAN act on `admin`/`lecturer`/`student` but CANNOT act on
another `super_admin`; nobody may act on their own account (every role,
asserted in one loop); soft-remove (`'removed'`) then reactivate
(`'active'`) round-trips; a direct client `PATCH` of `profiles.status` is
rejected even for the row's own owner and even for `super_admin` (the
`usted.allow_status_change` gate); and `class_roster()` now surfaces
`status`. The actual login/session BLOCK on a non-`active` account is an
app-layer check (`signIn`/`getSessionProfile`) this service-role/anon-key
script has no Next.js session to exercise directly — that round-trip
(suspend → blocked with the exact message → reactivate → sign-in works
again) was verified in the browser instead.

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
- Cloudflare R2 (proctoring media) replaces local Supabase Storage at deploy
  time via the storage adapter seam — the `R2_*` env vars in `.env.example`
  are placeholders until then; local/dev uses the Supabase `proctoring` bucket.
- `packages/proctor-core` must stay framework-agnostic: no React, no
  `@supabase/*` import anywhere in that package. New signals/adapters go
  through the existing `ProctorTransportAdapter`/`ProctorStorageAdapter`
  interfaces; identity-verification UI lives entirely in `apps/web` — the
  engine only exposes the generic `onTerminated()` hook it needs.
