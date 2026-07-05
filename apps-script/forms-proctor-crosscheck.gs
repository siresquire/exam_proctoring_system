/**
 * USTED proctoring platform — Phase 2b bypass-detection webhook.
 *
 * Paste this into your Google Form's Apps Script editor (Extensions > Apps
 * Script), fill in the three constants below from the platform's "Bypass
 * detection (Apps Script)" panel on your Forms quiz, then add an
 * installable onFormSubmit trigger (Triggers > Add Trigger > choose function
 * "onFormSubmit" > event source "From form" > event type "On form submit").
 * See README.md in this folder for the full step-by-step.
 *
 * What this does: every time ANYONE submits your form — including a student
 * who bypassed the proctored wrapper by opening the raw form URL directly —
 * this trigger fires in Google's cloud, reads the respondent's email
 * (requires "Collect email addresses" to be ON in your form's Settings) and
 * the submission timestamp, and POSTs them to the platform. The platform
 * cross-checks that submission against its own proctoring records and flags
 * it if there is no matching proctored session, or if it fell outside the
 * session's time window.
 *
 * Honest limits (also in README.md):
 *   - Matching is by email. If "Collect email addresses" is off, every
 *     submission is recorded as match_status="no_email" — turn it on.
 *   - This only fires for submissions Google Forms itself processes. A
 *     script/API-based submission that skips Google's form-submit flow
 *     entirely would not trigger onFormSubmit either — see RESEARCH.md §1.
 *   - This is a DETECTION signal for lecturer review, not a hard block. A
 *     flagged submission means "look at this", not "this is proven cheating".
 */

// ---- Fill these in from the platform's config panel ----------------------
const WEBHOOK_URL = "https://YOUR-DEPLOYMENT-DOMAIN/api/forms/submission"; // e.g. https://usted-proctor.vercel.app/api/forms/submission
const SUBMISSION_SECRET = "PASTE_THE_GENERATED_SECRET_HERE";
const FORMS_EXAM_ID = "PASTE_THE_FORMS_EXAM_UUID_HERE";
// ---------------------------------------------------------------------------

/**
 * Installable trigger handler. Do not rename — the trigger you add in the
 * Apps Script UI must point at a function named exactly `onFormSubmit`
 * (Apps Script also has a SIMPLE trigger of the same name that runs with
 * restricted permissions and cannot make external HTTP requests — you must
 * add this as an INSTALLABLE trigger via Triggers > Add Trigger for
 * UrlFetchApp to work).
 *
 * @param {GoogleAppsScript.Events.FormsOnFormSubmit} e
 */
function onFormSubmit(e) {
  try {
    const formResponse = e.response;
    const respondentEmail = formResponse.getRespondentEmail() || null;
    const submittedAt = formResponse.getTimestamp().toISOString();

    const payload = {
      forms_exam_id: FORMS_EXAM_ID,
      respondent_email: respondentEmail,
      submitted_at: submittedAt,
      raw: {
        formId: e.source ? e.source.getId() : undefined,
      },
    };

    const options = {
      method: "post",
      contentType: "application/json",
      headers: {
        "x-forms-secret": SUBMISSION_SECRET,
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    };

    const response = UrlFetchApp.fetch(WEBHOOK_URL, options);
    const status = response.getResponseCode();
    if (status !== 200) {
      // Logged to Apps Script's execution log (Executions in the left nav)
      // for the lecturer to notice if the webhook is misconfigured — this
      // never blocks or delays the student's actual form submission, which
      // has already completed by the time onFormSubmit runs.
      console.error(
        "Proctoring cross-check webhook returned " + status + ": " + response.getContentText(),
      );
    }
  } catch (err) {
    console.error("Proctoring cross-check webhook call failed: " + err);
  }
}
