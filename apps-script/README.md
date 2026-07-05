# Bypass detection (Phase 2b) — Apps Script install guide

This folder contains a small Google Apps Script (`forms-proctor-crosscheck.gs`)
that detects the core Forms-wrapper bypass: a student opening the raw Google
Form URL directly instead of going through the platform's proctored wrapper
page. It cannot prevent the bypass (nothing running on Google's side of a
Google Form can — see `docs/RESEARCH.md` §1) but it flags it for the
lecturer's review.

## How it works

1. Every time your form is submitted — through the proctored wrapper **or**
   directly by URL — Google Forms fires an `onFormSubmit` event server-side,
   in Google's cloud, after the submission is already recorded.
2. This script's `onFormSubmit(e)` function reads the respondent's email and
   the submission timestamp, and POSTs them to the platform's webhook
   (`/api/forms/submission`), authenticated with a per-exam shared secret.
3. The platform looks up whether that email has a proctored session for this
   exam whose time window contains the submission timestamp, and records one
   of four outcomes:
   - **matched** — a proctored session exists and the timing lines up.
   - **out_of_window** — a proctored session exists, but the submission
     landed outside it (e.g. submitted well after the session ended).
   - **no_session** (the bypass flag) — no proctored session exists at all
     for that email against this exam. This is the strongest bypass signal:
     the student never opened the wrapper.
   - **no_email** — the submission carried no email at all, because
     "Collect email addresses" is off (see the requirement below).
4. These show up in the lecturer's results page for this Forms quiz, next to
   the proctoring sessions themselves.

## Install steps

1. Open your Google Form (the one you already pasted into the platform's
   "New Forms quiz" builder).
2. **Settings → Responses → toggle "Collect email addresses" ON.** This is
   required — without it, Google Forms never gives Apps Script a respondent
   email, and every submission will be recorded as `no_email` (no way to
   cross-check anything). This is a Google Forms setting, not something the
   platform can turn on for you.
3. On the platform, open this quiz's **Results** page and find the
   **"Bypass detection (Apps Script)"** panel. Click **Generate secret** (or
   **Rotate secret** if you've done this before). The panel will show you
   three values — copy them, you'll need them in step 5:
   - `WEBHOOK_URL`
   - `FORMS_EXAM_ID`
   - `SUBMISSION_SECRET` — **shown once**, like an API key. If you lose it,
     rotate again (this invalidates the old one).
4. In your Google Form, click the **three-dot menu → Script editor**
   (or **Extensions → Apps Script**).
5. Delete any placeholder code in `Code.gs` and paste the entire contents of
   `forms-proctor-crosscheck.gs` from this folder. Replace the three
   placeholder constants at the top with the values from step 3.
6. Save the project (give it a name if prompted, e.g. "Proctoring cross-check").
7. Add the trigger: in the Apps Script editor, click the clock icon
   (**Triggers**) in the left sidebar → **+ Add Trigger** →
   - Function to run: `onFormSubmit`
   - Event source: `From form`
   - Event type: `On form submit`
   → **Save**.
8. Google will prompt you to authorize the script (it needs permission to
   read form responses and make external requests). Review and accept — this
   is your own script running under your own Google account, sending data
   only to the platform's webhook URL you configured.
9. **Test it**: submit your form once yourself (using an account whose email
   you've also used to take the quiz through the proctored wrapper, if you
   want to see a `matched` result), then check the platform's Results page —
   your submission should appear within a few seconds.

## Honest limitations

- **Matching is by email only.** If a student uses a different Google
  account for the raw-URL submission than the one they used (or didn't use)
  for the proctored session, this cross-check cannot connect the two. This
  is a detection signal for human review, not proof of identity.
- **`onFormSubmit` only fires for submissions Google Forms itself processes**
  through its normal UI submit flow. A submission made by directly POSTing
  to Google's internal form-response API (bypassing the Forms UI entirely)
  is a known theoretical edge case that would not trigger this trigger
  either — see `docs/RESEARCH.md` §1. In practice this is a much higher bar
  for a student to clear than "open the raw URL", and any absence of a
  matching session is still visible as missing data during grading.
- **This is evidence and deterrence, not prevention** (see `PLAN.md` §0). A
  `no_session` flag means "a human should look at this before assuming
  anything" — never an automatic penalty.
- **The shared secret is the only trust boundary.** Keep it as private as
  you would an API key. If you suspect it has leaked (e.g. you shared the
  script publicly with the real secret still in it), rotate it immediately
  from the platform's Results page — the old secret stops working the
  instant you do.
