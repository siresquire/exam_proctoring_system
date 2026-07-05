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

### Sign-in: email or index number (Phase 1.6)

The password tab accepts **either** a university email **or** a 10-digit USTED
index number (e.g. `5201040845`). Index resolution happens entirely
server-side in the `signIn` server action (`apps/web/app/login/actions.ts`):
if the identifier is 10 digits it is looked up via a **service-role** client
(`apps/web/lib/supabase/admin.ts`, server-only — the key is never shipped to
the browser and the index→email mapping is never exposed) and the resolved
email is used for the real password sign-in. Every failure returns one generic
"Invalid email/index number or password" so the form is not an
account-enumeration oracle. This exists because student onboarding must not
depend on email deliverability before a domain is purchased (see PLAN.md
"Student onboarding without a domain"): admins hand out index + temp password;
the magic-link tab remains but is labelled as needing a configured sending
domain.

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
