# Research Findings — Exam Proctoring & Anti-Cheat System (USTED)

> Compiled 2026-07-04 from four parallel research passes: Google Forms feasibility,
> free-tier hosting, browser proctoring techniques, and commercial platform parity.
> This file is the evidence base for [PLAN.md](../PLAN.md).

---

## 1. Google Forms add-on feasibility

**Verdict: a Google Forms add-on alone CANNOT proctor students.** Google's official docs:
*"Forms add-ons only extend the Forms editor itself, where the forms are constructed.
Forms add-ons can't extend the form that is presented to potential respondents."*
Add-on code (sidebars, dialogs, menus) runs only in the lecturer's editor view. No Apps
Script mechanism can execute JavaScript in the respondent's browser during form-filling,
so tab-switch detection, webcam monitoring, etc. are structurally impossible inside a
pure add-on.

### How real products do it (Quilgo, autoProctor, ProctorExam)
They **wrap the form**: the vendor generates a unique proctored link; the student opens
the vendor's page, which iframes the Google Form and runs all proctoring JS
(visibility/blur events, `getUserMedia` webcam, face detection) on the *parent* page.
The Marketplace "add-on" is just lecturer-side setup/integration (pull form ID, add
timer, generate links) — not the proctoring engine.

### Key technical notes
- Public Google Forms **can** be iframed (Google provides an embed feature). Forms
  restricted to "users in organization" break in iframes because the Google login
  screen sends `X-Frame-Options` — use public forms + identity binding instead.
- `onFormSubmit` installable trigger fires server-side *after* submission — useful for
  cross-checking submission time against the proctoring session, not live monitoring.
- **Core bypass risk**: a student who learns the raw `viewform` URL can take the form
  unproctored. Mitigations used by vendors: per-session tokenized links, hidden real
  form URL, exam time-window locking (form accepts responses only during the window),
  pre-filled hidden session-ID field bound to each response, timestamp cross-checks,
  and flagging anomalous submissions for manual review. None are airtight —
  the model is *detect and flag*, not *prevent*.
- Marketplace publishing needs OAuth consent verification + app review (~2–3 weeks).
  For internal university use, an unlisted/domain-installed add-on avoids most of this.

---

## 2. Free-tier hosting (verified limits, 2026)

**Recommended primary stack: Next.js on Vercel (Hobby) + Supabase free (Postgres,
Auth, Realtime, RLS) + Cloudflare R2 free (proctoring media, zero egress fees).**
Fallback: Cloudflare Pages/Workers instead of Vercel (explicitly education-friendly
ToS, no 10s function timeout concern, native R2 pairing).

| Service | Key free-tier limits |
|---|---|
| Supabase Free | 500MB DB; 1GB storage; 5GB egress/mo; 50k MAU auth; Realtime **200 concurrent peak connections**, 2M msgs/mo; 500k edge fn invocations; 60 direct / 200 pooled DB connections; **pauses after 7 days idle**; 2 projects max |
| Vercel Hobby | 100GB bandwidth; 1M fn invocations; **10s function cap**; non-commercial ToS (internal academic tool is a gray area — Cloudflare/Netlify are the clean fallback) |
| Cloudflare Pages/Workers | 100k requests/day; unlimited static bandwidth |
| Cloudflare R2 | **10GB storage, $0 egress always**; 1M writes + 10M reads/mo |
| Backblaze B2 | 10GB storage (secondary/backup option) |
| Cloudflare Realtime/TURN | 1,000GB/mo free (if live WebRTC ever needed) |
| GitHub Student Pack | Free credits for Vercel, Supabase, etc. — activate first |

### Storage math (the decisive constraint)
- JPEG snapshot every 30s @ ~80KB ≈ **9.6MB per student-hour**
- Snapshot every 10s ≈ 29MB/student-hour
- Continuous 480p video ≈ **225MB/student-hour**; 720p ≈ 675MB/student-hour
- 200 students × 2h exam: snapshots ≈ **3.8GB (fits R2 free)**; continuous 480p ≈ 90GB (impossible on any free tier)

**Conclusion: periodic snapshots (15–30s) + short event-triggered clips only. No
continuous video recording on a $0 budget.** Retention purge required to stay under 10GB.

### Concurrency: 200 simultaneous test-takers?
Marginal. Supabase realtime cap is exactly 200 concurrent connections (including
lecturer dashboards). Realistic free-tier ceiling ≈ **150–180 concurrent students**;
beyond that, stagger cohorts into sessions — or pay Supabase Pro ($25/mo) for exam
weeks only. All DB access must go through the connection pooler (transaction mode).
Media uploads must go client→R2 directly via presigned URLs, never through a
serverless function (10s cap).

### Failure modes & mitigations
| Risk | Mitigation |
|---|---|
| Supabase pauses after 7 days idle | Cron keep-alive ping (GitHub Actions, free) every 3–5 days |
| Cold start at exam open (stampede) | Pre-warm 10–15 min before; stagger student joins over 5–10 min |
| Function timeout on media upload | Presigned direct-to-R2 uploads |
| Realtime cap hit mid-exam | Count expected connections; degrade to polling fallback |
| Vercel Hobby ToS ambiguity | Move to Cloudflare Pages / Netlify if challenged |

---

## 3. Browser proctoring techniques — desktop vs mobile

### Desktop technique matrix
| Technique | Detects | Support | Bypass |
|---|---|---|---|
| Fullscreen API + exit detection | Leaving fullscreen | All desktop browsers | Esc exits (we detect it); second monitor unaffected |
| Page Visibility API | Tab switch, minimize | Universal | Side-by-side windows never hide the tab |
| `window.blur`/`focus` | App/window switch | Universal | Always-on-top apps, PiP video |
| Keyboard Lock API | Block Esc/Alt-Tab | Chrome/Edge only; Chrome removed its permission prompt in Mar 2026 — treat as unreliable | OS shortcuts still work |
| Copy/paste/context-menu block | Clipboard use | Universal | DevTools, extensions, OS clipboard tools |
| Multi-monitor detection (`screen.isExtended`) | Extra displays | Chrome/Edge only, needs permission | Deny permission; second *device* invisible |
| `getDisplayMedia` screen recording | Screen contents | Desktop only | Student picks "this tab only" — fundamental hole |
| DevTools detection | Console open | Heuristics only | Trivially defeated; false positives |

### Webcam AI (all client-side = free)
- **MediaPipe Tasks Vision FaceLandmarker/BlazeFace** (WASM/WebGPU): real-time face
  presence, multiple faces, coarse head-pose/gaze. Degrades on old CPUs — sample
  every 1–2s, don't run per-frame.
- **Phone detection**: TF.js COCO-SSD (`cell phone` class) — fast but misses
  small/angled phones; YOLO via ONNX Runtime Web is more accurate but heavier
  (single-digit FPS on old laptops — fine for periodic sampling). Treat as a
  *flag generator*, never as proof.
- **Audio**: mic energy/volume spikes are cheap; real speech detection is noisy.
  Use as low-severity signal only.

### Mobile verdict (the user's key question)
| Capability | Android Chrome | iOS Safari |
|---|---|---|
| Fullscreen enforcement | Partial, easy to exit | **None on iPhone** (API unsupported) |
| App-switch detection (`visibilitychange`) | Unreliable — often doesn't fire | Unreliable (platform limitation) |
| Screenshot detection | No | No |
| Split-screen / floating window detection | No | No |
| Camera while browser backgrounded | No — stream suspended/killed | No |
| Screen recording (`getDisplayMedia`) | No reliable support | Not exposed at all |

**Honest verdict: mobile-browser proctoring cannot approach desktop integrity.**
Commercial vendors block phones (Honorlock allows iPad only) or require a native app
with kiosk mode (Android `startLockTask()` / iOS Guided Access). Realistic mobile
strategies: (a) restrict high-stakes exams to desktop, (b) allow mobile for low-stakes
quizzes with webcam-snapshot monitoring + disclosed reduced integrity, (c) use the
phone as a **second camera** beside a required laptop, (d) longer-term: a thin native
Android app (kiosk mode) since most USTED students are on Android.

### What production systems actually do
Client-side signals are *soft evidence*, not prevention. Vendors combine lockdown
clients + recording + human/AI review + deterrence. **Safe Exam Browser (SEB)** is
free, open-source (Windows/macOS/iOS; weak on Android), and verifiable server-side via
Config Key / Browser Exam Key request headers — a free platform can require SEB for
high-stakes desktop exams.

### Server-side signals (zero client trust — the most bypass-resistant layer)
Per-student random question draw; one-question-at-a-time delivery; randomized option
order; inter-question timing analysis (impossibly fast answers, synced timing across
students); IP/user-agent/fingerprint change mid-attempt; concurrent-session detection;
post-hoc answer-similarity clustering. These work identically on any device including
mobile.

---

## 4. Commercial platform parity & compliance

### Proctoring modes offered across the industry
1. Record-and-review (async AI + human review) — best fit for a free system
2. Live human proctoring (ProctorU-style) — feasible free at small scale via realtime dashboard
3. AI-only auto-proctoring — controversial without human review
4. Lockdown-only (SEB / Respondus) — no monitoring, just prevention

### Integrity flag taxonomy (industry-standard severities)
| Event | Severity |
|---|---|
| Background noise / brief distraction | Low |
| Single short tab/window switch | Low–Medium |
| Continual gaze off-screen | Medium |
| Face not visible | Medium |
| Voice/conversation detected | Medium–High |
| Multiple faces / second person | High |
| Secondary device detected | High |
| Repeated fullscreen exits / lockdown breach | High |
| Copy-paste / app switch during lockdown | High |

Flags roll up to a session-level Low/Medium/High integrity score. Review UI standard:
timeline with clickable flag markers → per-flag reviewer verdict → session verdict
(pass / escalate / violation) → appeal step.

### Role/permission matrix (target)
| Capability | Super Admin | Admin | Lecturer | Student |
|---|---|---|---|---|
| System config, integrations, full audit log | ✔ | scoped | — | — |
| Create users & assign roles | ✔ | ✔ (≤ lecturer) | — | — |
| Create classes, enroll students | ✔ | ✔ | ✔ (own) | — |
| Question banks | ✔ | ✔ | ✔ (own/shared) | — |
| Create/schedule exams | ✔ | ✔ | ✔ (own classes) | — |
| Monitor live sessions / review flags | ✔ | ✔ | ✔ (own exams) | — |
| Grade & override | ✔ | ✔ | ✔ (own) | — |
| Take exams / view own results / appeal | ✔ | — | — | ✔ |

**Super admin is universal by design (user decision, 2026-07-04): it passes every
permission check in the system — anything an admin, lecturer, or student can do,
super admin can do.** Modeled on Moodle's capability system. **Append-only audit log** (actor, action,
target, timestamp, IP) on every grade change, role change, exam edit, and review
verdict is a hard requirement for defensible integrity decisions.

### Question bank best practices
- Category tree (course → topic → subtopic) + free tags + difficulty level
- Random N-from-pool per student; randomized option order; retire items after use cycles
- **Version questions instead of editing in place** — past attempts must stay auditable
  against the exact wording served
- Item statistics: difficulty index 0.25–0.75 and discrimination ≥ 0.20 are keepers

### Fairness / privacy / legal must-haves
- **AI bias is documented**: darker-skinned students flagged 4–5× more in a
  peer-reviewed study; ADHD/autism behaviors trigger false flags. **Rule: no automatic
  penalty from AI flags — human review before any consequence.** This is a fairness
  and a legal-defensibility requirement.
- **No mandatory room scans** (Cleveland State 2022 precedent).
- **Ghana Data Protection Act 2012 (Act 843)**: USTED as data controller should
  register with the Data Protection Commission; explicit consent required before
  webcam/biometric capture; publish purpose + retention policy; secure processing.
  Build a consent screen into every proctored session and an auto-purge retention job.
- Accommodations flag per student that suppresses/annotates automated flags.
- Low-bandwidth fallback is a **gap in every commercial platform** — designing for it
  (autosave, resume-on-disconnect, snapshot-over-video, offline answer caching) is
  USTED's differentiator.

### Open source worth reusing
- **Safe Exam Browser + SEB Server** (MPL) — lockdown + server verification
- **Moodle quiz engine** — reference architecture for banks/random draw/roles
- **vardanagarwal/Proctoring-AI**, **prnvdixit/Engaze** — OpenCV face/gaze reference
  implementations (Engaze targets low-bandwidth explicitly)
