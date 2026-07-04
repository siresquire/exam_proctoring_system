# Design System & Accessibility Specification

> Governs all UI work on both systems. Owner is an MPhil IT student and HCI T.A. —
> the platform must demonstrate intentional interaction design, not just pass checks.
> Target: **WCAG 2.2 Level AA** across the board.

## 1. Foundations

| Concern | Decision |
|---|---|
| Component library | **shadcn/ui** (Radix primitives + Tailwind) — accessible-by-default focus management, keyboard handling, ARIA wiring |
| Iconography | **lucide-react** (shadcn's companion set) — always paired with text labels or `aria-label`; never icon-only meaning |
| Typography | **Inter** (variable, self-hosted via `next/font` — no CDN: privacy + Ghana bandwidth). **JetBrains Mono** for codes/IDs/timers. Base 16px, `rem` units everywhere, line-height ≥ 1.5 |
| Popups & notifications | **SweetAlert2** for all alerts, confirmations, and toasts — wrapped in a single `lib/notify.ts` utility (see §4). shadcn/Radix `Dialog` for in-flow modal forms |
| Color | Tailwind CSS variables (shadcn theming). All pairs ≥ 4.5:1 contrast (3:1 for large text/UI parts). Semantic tokens: `success/warning/destructive/info` never conveyed by color alone (icon + text always) |
| Themes | Light (default), dark, and high-contrast — user-switchable, persisted, respects `prefers-color-scheme` |
| Motion | All animation behind `prefers-reduced-motion` guard, incl. SweetAlert2 (`showClass/hideClass` disabled when reduced) |

## 2. Interaction design principles (mapped to Nielsen heuristics)

1. **Visibility of system status** — persistent autosave indicator ("Saved 12:04:31"),
   connection-state badge, server-authoritative timer always visible; nothing happens
   silently during an exam.
2. **User control & freedom** — review-before-submit answer sheet, flag-question-for-
   later, undo where destructive actions can't be confirmed.
3. **Error prevention over error messages** — confirmations (SweetAlert2) on submit /
   leave-exam / delete; unanswered-question warning listing question numbers; disabled
   states always explain themselves (tooltip + `aria-describedby`).
4. **Recognition over recall** — breadcrumbs, question palette showing
   answered/flagged/unseen states, no memorized codes required of students.
5. **Aesthetic & minimalist** — the exam room is deliberately low-distraction: one
   question, timer, palette, nothing else. Admin density lives in dashboards, not
   student views.
6. **Help users recover** — every error states what happened, why, and the next
   action, in plain language. Network loss shows a calm reconnecting state, never a
   scary failure (answers are buffered locally).

## 3. Accessibility requirements (WCAG 2.2 AA — enforced, not aspirational)

### Perceivable
- Semantic HTML first (`nav/main/section/button`); ARIA only where semantics fall short
- Text resizable to 200% without loss; layouts in `rem`/flex/grid, no fixed-height text boxes
- Alt text on all informative images; decorative images `alt=""`
- Question content supports rich text + images with required alt on authoring side

### Operable
- **Everything keyboard-operable**, no traps; logical tab order; visible focus ring
  (≥ 2px, meets 2.4.11 Focus Not Obscured); skip-to-content link on every page
- Touch targets ≥ 44×44px on interactive controls (mobile students)
- **No drag-only interactions** (2.5.7): any drag-drop question type ships with a
  click/keyboard alternative
- **Timing adjustable (2.2.1)**: per-student **extra-time multiplier** (e.g. 1.25×,
  1.5×, 2×) and scheduled-break pause, set via the accommodations flag on the profile —
  this is a first-class exam-engine feature, not a workaround
- No flashing content, ever

### Understandable
- `lang` attributes; plain-language microcopy (many students are ESL)
- Consistent navigation and component behavior across roles
- Form errors: inline, associated via `aria-describedby`, focus moved to first error,
  error summary at top; labels always visible (no placeholder-as-label)

### Robust
- ARIA live regions: exam timer announces at sensible intervals (30/15/5/1 min —
  `aria-live="polite"`), autosave and connection changes polite, integrity warnings
  `role="alert"` only when action is required (assertive announcements are stressful —
  use sparingly in a timed exam)
- Tested with **NVDA** (Windows) and **TalkBack** (Android) before each phase exit;
  axe-core in CI; keyboard-only manual pass on every new screen

### Proctoring-specific accessibility (novel — most vendors fail here)
- **Assistive-tech interaction policy**: screen magnifiers, switch access, and some AT
  can trigger `blur`/focus events. The accommodations flag suppresses or annotates
  those automated flags so disabled students aren't false-flagged (documented industry
  failure we explicitly design against).
- Webcam requirements adjustable per accommodation (e.g., students who cannot maintain
  head position aren't penalized by head-pose heuristics).
- Consent and instruction screens fully screen-reader navigable; camera-check step
  gives non-visual feedback ("Camera detected: OK").

## 4. `lib/notify.ts` — the single SweetAlert2 gateway

All popups/toasts go through this module; direct `Swal.fire()` calls are lint-banned.
It enforces: theme-aware styling (CSS variables), `returnFocus: true`,
`allowEnterKey`/Escape behavior per type, reduced-motion handling, `role`/aria
config, and a consistent API: `notify.confirm()`, `notify.success()`,
`notify.error()`, `notify.toast()`, `notify.examWarning()` (the special low-stress
variant used inside the exam room).

## 5. Definition of Done (every screen, every phase)

1. Keyboard-only walkthrough passes
2. axe-core: zero critical/serious violations
3. Contrast verified in all three themes
4. NVDA reads the flow sensibly
5. Works at 200% zoom and at 375px viewport
6. Reduced-motion honored
7. All notifications routed through `notify.ts`
