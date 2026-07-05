/**
 * Phase 3a: temp password generation for onboarding without email.
 *
 * Generated with the Web Crypto API (`crypto.getRandomValues`, available in
 * both the Node.js server actions run under and any edge runtime — no extra
 * dependency), NOT `Math.random()`, since this value briefly *is* the
 * account's actual password (until the student changes it) and is handed
 * out on a roster export.
 *
 * Deliberately excludes visually-confusable characters (0/O, 1/l/I) since
 * these are read off a printed/exported roster and typed back in by a
 * student, often on a phone keyboard — a typo here is a support ticket, not
 * just an inconvenience.
 */

const TEMP_PASSWORD_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
const TEMP_PASSWORD_LENGTH = 12;

/** Generates a readable, crypto-random temp password (default 12 chars from a confusable-character-free alphabet). */
export function generateTempPassword(length: number = TEMP_PASSWORD_LENGTH): string {
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += TEMP_PASSWORD_ALPHABET[bytes[i] % TEMP_PASSWORD_ALPHABET.length];
  }
  return out;
}
