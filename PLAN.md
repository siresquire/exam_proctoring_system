# USTED Exam Proctoring & Anti-Cheat Platform — Implementation Plan

> Evidence base: [docs/RESEARCH.md](docs/RESEARCH.md). Budget: $0 (free tiers).
> Two deliverables: **System 1** — proctored Google Forms wrapper for lecturers;
> **System 2** — full assessment platform with roles, question banks, and proctoring.

---

## 0. Decisions that shape everything

1. **A Google Forms add-on cannot proctor.** Add-ons only run in the lecturer's form
   editor, never in the student's view (Google's own docs). System 1 must therefore be
   a **proctored wrapper page** that iframes the Google Form and runs the monitoring
   around it — exactly how Quilgo and autoProctor work. The "add-on" part is just the
   lecturer's setup tool.
2. **Systems 1 and 2 share one proctoring engine.** The wrapper page (System 1) and
   the platform exam room (System 2) use the same client-side proctoring module and
   the same event/flag/review backend. Build once, ship twice.
3. **Evidence + deterrence, not prevention.** Everything client-side is bypassable.
   The system's integrity comes from layered signals + human review + server-side
   measures (randomization, timing analysis) that need zero client trust.
4. **No AI-only punishment.** AI flags (face/phone detection) have documented bias and
   false-positive problems. Flags always route to human review before any consequence.
5. **Snapshots, not video.** Free storage (R2, 10GB) supports periodic webcam JPEG
   snapshots + short event-triggered clips (~4GB per 200-student 2-hour exam), never
   continuous recording.
6. **Mobile gets a tiered answer, not a yes/no** (see §2).

## 1. Stack

| Layer | Choice | Why |
|---|---|---|
| Web app | **Next.js (TypeScript) on Vercel Hobby** | SSR + API routes, one project hosts both systems |
| DB / Auth / Realtime | **Supabase free** | Postgres + RLS role enforcement + realtime for live monitoring, one service |
| Proctoring media | **Cloudflare R2 free** | 10GB + zero egress; client uploads via presigned URLs |
| Client AI | **MediaPipe Tasks Vision + TF.js COCO-SSD** | Face presence/multi-face/head-pose + phone detection, runs in the student's browser = free |
| Lecturer setup (System 1) | **Apps Script add-on (domain-installed)** | Pull form ID, generate tokenized links, receive onFormSubmit cross-checks |
| High-stakes lockdown (later) | **Safe Exam Browser** | Free, open source, server-verifiable via Config Key headers |
| Keep-alive / cron | **GitHub Actions** | Ping Supabase every 3–5 days (free tier pauses after 7 idle days); pre-warm before exams |

Fallback host if Vercel's non-commercial ToS is ever an issue: Cloudflare Pages.
First action: activate the **GitHub Student Developer Pack** (free Vercel/Supabase credits).

Repo shape: single Next.js app + `packages/proctor-core` (framework-agnostic proctoring
module) + `apps-script/` (System 1 add-on). One Vercel project, one Supabase project.

## 2. Mobile: the honest answer

Mobile **browsers** cannot be locked down: no fullscreen on iPhone, unreliable
app-switch detection, no screen capture, and the camera dies when the browser is
backgrounded. No web technology fixes this. So the platform offers **integrity tiers**
that lecturers pick per exam:

| Tier | Devices | Enforcement |
|---|---|---|
| **T1 – Quiz** | Any (phone OK) | Server-side only: random draw, shuffled options, one-question-at-a-time, timing analysis, session/IP checks. No camera. |
| **T2 – Monitored** | Phone or laptop | T1 + webcam snapshots + face presence + what signals the device *does* support, with the reduced coverage disclosed and logged. Good for continuous assessment. |
| **T3 – Proctored** | Desktop/laptop required | T2 + fullscreen lock + tab/app-switch detection + phone-in-view detection + optional screen share. |
| **T4 – High stakes** | Desktop + SEB (or supervised lab) | T3 + Safe Exam Browser verification. Phones as **second camera** optional. |

This is defensible to students ("laptop issues" → T1/T2 exams work fine on a phone;
final exams are T3/T4, same as every commercial platform, which block phones outright).
A native Android kiosk-mode app can raise mobile to ~T3 later (Phase 7, optional).

## 3. Data model (core tables)

`profiles` (role: super_admin | admin | lecturer | student, accommodations flag) ·
`classes` · `class_members` · `question_banks` · `questions` (**versioned rows, never
edited in place**; type, difficulty, tags) · `exams` (tier, window, duration, draw
config: N-from-pool per section) · `exam_attempts` (per-student frozen question set +
option order, autosave state) · `answers` · `proctor_sessions` · `proctor_events`
(type, severity, timestamp, metadata) · `media_artifacts` (R2 keys) · `reviews` +
`review_verdicts` · `appeals` · `audit_log` (**append-only**, every privileged action) ·
`forms_exams` / `forms_sessions` (System 1 wrapper configs and tokenized sessions).

All access via Supabase RLS keyed to role + ownership (lecturer sees own classes/exams
only; students see only their own attempts). Media served via short-lived signed URLs.

## 4. Phases

### Phase 0 — Foundations (week 1–2)
Repo, Next.js + Supabase + R2 wiring, **design system per
[docs/DESIGN.md](docs/DESIGN.md)** (shadcn/ui, lucide, Inter via next/font, themes
incl. high-contrast, `lib/notify.ts` SweetAlert2 gateway, axe-core in CI), auth with
the four roles, RLS policies, append-only `audit_log` with a write-through helper,
GitHub Actions keep-alive cron, CI. **Exit:** users can sign in with correct
role-gated dashboards; every privileged action lands in the audit log; design-system
Definition of Done (DESIGN.md §5) passes on the shell screens.

### Phase 1 — Proctoring engine core (week 2–4)
`packages/proctor-core`: heartbeat, event capture (visibilitychange, blur/focus,
fullscreen enter/exit, copy/paste/context-menu, devtools heuristics, network drop &
resume), batched event upload with offline buffering, webcam capture + periodic JPEG
snapshot pipeline (presigned R2 upload), consent screen (Ghana DPA: explicit consent,
purpose, retention). Severity mapping per the industry taxonomy in RESEARCH.md.
**Exit:** a demo page produces a complete, timestamped event + snapshot trail for a
session, surviving refreshes and network drops.

### Phase 1.5 — Identity, violation policy, branding (added 2026-07-05, user requirements)
- **Violation threshold**: configurable strikes (default 3 high-severity violations)
  → server-side auto-termination of the session + a report record queued for review
  by the issuing lecturer/admin. Enforced in the `log_proctor_events` RPC (client
  can't dodge it); client reacts by locking the exam UI and informing the student.
- **Identity verification before every proctored session**: clear face portrait
  capture (stored as session evidence) + index number entry + explicit attestation:
  impersonation is an academic offense at USTED punishable by exam cancellation,
  withdrawal from the institution, and other disciplinary measures.
- **USTED index numbers**: ~10-digit numeric (e.g. 5201040845; serials vary by
  admission year and programme). Validate `^\d{10}$` client-side and as a DB CHECK
  on `profiles.student_number`; entered index number is cross-checked against the
  profile's student_number when set, mismatch = high-severity flag (not a hard block —
  registry data may lag; the portrait is the primary evidence).
- **Branding**: official AAMUSTED logo (cropped-AAMUSTED-NEW-LOGO-26.png) in header +
  login; brand palette derived from it (maroon primary, gold accent, green success)
  applied across light/dark/high-contrast themes with WCAG-verified contrast.
- **Font-size control**: user-adjustable text scaling (100–150%) persisted per user,
  alongside the theme toggle (WCAG 1.4.4 beyond browser zoom).
- Demo page gets **sample quiz questions** so violations are experienced in a
  realistic test-taking flow.

### Phase 2 — **System 1 ships: proctored Google Forms wrapper** (week 4–6)
- `/proctor/[token]` page: consent → camera check → iframes the lecturer's Google Form
  → proctor-core runs around it → submit confirmation.
- Lecturer flow: paste form URL (or use the Apps Script add-on), set exam window +
  tier, generate per-student tokenized links (emailed or CSV export).
- Anti-bypass: form kept unlisted; responses accepted only inside the window (add-on
  toggles "accepting responses"); hidden pre-filled session-ID field binds each
  response to a proctored session; `onFormSubmit` trigger posts submission timestamps
  back to the platform; unmatched/out-of-window submissions auto-flagged.
- Lecturer report per session: integrity score, event timeline, snapshot strip,
  flagged-students summary (the "self-reporting" you asked for).
**Exit:** a real lecturer runs a real quiz through it. This is the quick win — System 1
is in lecturers' hands while System 2 is still being built.

### Phase 3 — Platform core: classes, banks, exams (week 6–10)
Classes + enrollment (CSV import), question banks with category tree/tags/difficulty
and question versioning. **Question authoring**: form-based editor per type, plus
**bulk import** — CSV/XLSX template with validation-preview-before-import, and
Aiken + GIFT plain-text formats (Moodle-compatible migration path). Exam builder (MCQ single/multi, true/false, numeric, short
answer, essay first; sections, N-from-pool random draw, per-student shuffling),
scheduling windows, exam room UI (one-question-at-a-time, autosave every answer,
resume-on-disconnect, server-authoritative timer), auto-grading for objective types +
manual grading queue for essays, results release controls.
**Exit:** a full unproctored exam lifecycle works end-to-end on desktop *and* mobile
(T1 tier), because low-bandwidth resilience is built into the exam room from day one.

### Phase 4 — Proctoring integrated + live monitoring + review (week 10–13)
Attach proctor-core to the exam room by tier; **live monitoring dashboard** for
lecturers (Supabase realtime: student roster, latest snapshot, live flags, "message
student" nudge); post-exam **review workspace** (timeline with clickable flag markers →
per-flag verdict → session verdict pass/escalate/violation → student notification +
**appeal** submission); accommodations flag suppresses/annotates automated flags.
Server-side analytics job: timing anomalies, answer-similarity clustering, IP/UA
changes, concurrent sessions.
**Exit:** proctored exam runs with live view; every flag reaches a human verdict;
audit trail defensible.

### Phase 5 — Webcam AI + identity (week 13–16)
Pre-exam identity step (selfie + student-ID photo, manual lecturer spot-check — no
automated face *matching*, which is biometric-heavy and bias-prone); in-exam MediaPipe
face presence / multiple-face / coarse head-pose sampled every 1–2s; COCO-SSD phone
detection on periodic frames; event-triggered short clips (10s) on high-severity
events; graceful degradation on weak devices (skip AI, keep snapshots).
**Exit:** T3 exams flag no-face/multi-face/phone-in-view with acceptable false-positive
rates on real (dark-skin-tone diverse!) test footage before any real exam uses it.

### Phase 6 — Hardening, compliance, pilot (week 16–20)
SEB integration for T4 (config generator + Config-Key request verification); retention
auto-purge job (align to appeal window, keeps R2 under 10GB); load test at 150–200
concurrent (pooled connections only; staggered joins; realtime-cap fallback to
polling); exam-day runbook (pre-warm cron, cohort staggering >180 students); Ghana DPA
checklist (consent text, retention policy, DPC registration guidance for USTED);
super-admin observability (error log, audit browser, storage/quota dashboard).
**Pilot:** one course, low-stakes quiz → monitored midterm → review with the lecturer →
iterate → department rollout.

### Phase 7 — Optional future
Native Android kiosk-mode app (raises mobile to ~T3); phone-as-second-camera flow;
item statistics (difficulty/discrimination) on the question bank; LMS/LTI integration;
Supabase Pro ($25/mo) for exam weeks if concurrency outgrows free tier.

## 5. Risk register (top 5)

| Risk | Mitigation |
|---|---|
| Free-tier outage mid-exam | Keep-alive cron, pre-warm, staggered starts, autosave + resume, offline answer buffer |
| Student bypasses wrapper (System 1) | Tokenized links, response window locking, session-ID binding, onFormSubmit cross-check → flag, not prevent |
| AI flags discriminate (skin tone, ADHD) | Human review mandatory, accommodations flag, diverse test footage before rollout, flags are evidence not verdicts |
| >200 concurrent students | Stagger cohorts; polling fallback; $25/mo Supabase Pro during exam weeks as the paid escape hatch |
| Privacy/legal challenge | Explicit consent screen, no room scans, published retention + auto-purge, Ghana DPA registration |

## 6. Immediate next steps

1. Activate GitHub Student Developer Pack; create Supabase project, Vercel project,
   Cloudflare R2 bucket; put credentials in a password manager.
2. Scaffold the monorepo (Phase 0).
3. Build proctor-core (Phase 1) — it's the shared heart of both systems.
