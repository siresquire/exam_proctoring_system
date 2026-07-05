/**
 * Phase 2a: normalizes a lecturer-pasted Google Form URL into the embeddable
 * form the student wrapper's iframe uses.
 *
 * Google Forms share links come in a few shapes a lecturer might paste:
 *   - https://docs.google.com/forms/d/e/<id>/viewform
 *   - https://docs.google.com/forms/d/e/<id>/viewform?usp=sf_link
 *   - https://docs.google.com/forms/d/<id>/edit  (the EDIT link — never
 *     usable by students, common copy-paste mistake)
 *   - https://forms.gle/<shortcode>               (Google's shortlink — we
 *     cannot resolve this server-side without following a redirect, which
 *     Google's shortlink service does over HTTPS; rejected here with
 *     guidance rather than attempting a fetch from the server action, to
 *     keep this a pure, dependency-free function that both the client form
 *     and the server action can call identically)
 *
 * All of them normalize to ".../viewform?embedded=true" — the query param
 * Google documents for embedding a form in an iframe (RESEARCH.md §1).
 *
 * This runs BOTH client-side (immediate validation feedback in the builder
 * form) and server-side (the server action re-validates — never trust the
 * client's normalization, same posture as every other input in this repo).
 */

export interface NormalizeGoogleFormUrlResult {
  ok: boolean;
  /** The normalized, embeddable URL. Only set when ok is true. */
  url?: string;
  /** Human-readable reason, shown directly in the form's error text. Only set when ok is false. */
  error?: string;
}

const FORMS_HOST_PATTERN = /^(www\.)?docs\.google\.com$/i;
const SHORTLINK_HOST_PATTERN = /^forms\.gle$/i;

export function normalizeGoogleFormUrl(input: string): NormalizeGoogleFormUrlResult {
  const trimmed = input.trim();
  if (!trimmed) {
    return { ok: false, error: "Enter a Google Form URL." };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: "That doesn't look like a valid URL." };
  }

  if (parsed.protocol !== "https:") {
    return { ok: false, error: "The form URL must use https://." };
  }

  if (SHORTLINK_HOST_PATTERN.test(parsed.hostname)) {
    return {
      ok: false,
      error:
        "forms.gle short links aren't supported — open the link once in a browser, then paste the full docs.google.com/forms/... URL from the address bar.",
    };
  }

  if (!FORMS_HOST_PATTERN.test(parsed.hostname)) {
    return {
      ok: false,
      error: "That isn't a Google Forms link. Paste the form's docs.google.com/forms/... URL.",
    };
  }

  if (!/^\/forms\//i.test(parsed.pathname)) {
    return {
      ok: false,
      error: "That isn't a Google Forms link. Paste the form's docs.google.com/forms/... URL.",
    };
  }

  // The edit link (".../edit", ".../edit#responses", etc.) is a common
  // copy-paste mistake — it's the lecturer's private authoring URL, not the
  // respondent-facing form, and it will not embed for students the same way.
  if (/\/edit(\/|$)/i.test(parsed.pathname)) {
    return {
      ok: false,
      error:
        "This looks like the form's edit link (only you can use it). In Google Forms, click Send, then copy the Link option instead.",
    };
  }

  if (!/\/viewform\/?$/i.test(parsed.pathname)) {
    return {
      ok: false,
      error:
        "This doesn't look like a form response link. In Google Forms, click Send, then copy the Link option.",
    };
  }

  const normalized = new URL(parsed.origin + parsed.pathname);
  normalized.searchParams.set("embedded", "true");

  return { ok: true, url: normalized.toString() };
}
