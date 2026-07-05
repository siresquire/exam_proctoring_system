/**
 * Phase 3b GIFT format parser — a SUBSET of Moodle's GIFT plain-text format.
 *
 * SUPPORTED:
 *   - `::title::` prefix (optional, stripped and ignored — GIFT titles have
 *     no equivalent field in this schema; the prompt itself is used as-is).
 *   - `$CATEGORY: Topic/Subtopic` lines — set the category path applied to
 *     every subsequent question in the file, until the next $CATEGORY line.
 *   - Multiple choice: `{ =Correct answer ~Wrong ~Wrong }` -> mcq_single.
 *     Multiple `=` entries -> mcq_multi.
 *   - True/false: `{TRUE}`, `{FALSE}`, `{T}`, `{F}`.
 *   - Short answer: `{ =answer1 =answer2 }` (only `=` entries, no `~`) ->
 *     short_answer with all `=` entries as accepted answers.
 *   - Numeric: `{#answer:tolerance}` or `{#answer}` (tolerance 0) -> numeric.
 *   - Blank-line-separated items (like Aiken); `//` line comments (a line
 *     whose first non-whitespace characters are `//` is skipped entirely).
 *   - Escaped special characters `\:`, `\~`, `\=`, `\#`, `\{`, `\}` are
 *     unescaped in output text.
 *
 * EXPLICITLY NOT SUPPORTED (rejected with a clear per-row error, not
 * silently mis-parsed):
 *   - Per-option feedback (`# feedback text` after an option) — parsed OUT
 *     and DISCARDED (ignored), not preserved anywhere in this schema.
 *   - Per-option weights (`%50%Answer`) — REJECTED: this schema has no
 *     partial-credit model for mcq options, so a weighted item is flagged
 *     as an error rather than silently importing a wrong marks scheme.
 *   - Matching (`{ = A -> 1 = B -> 2 }`) and embedded/Cloze (multiple `{}`
 *     per line) sub-questions — REJECTED, no equivalent question type here.
 *   - Essay GIFT items (`{}`) — REJECTED: GIFT's essay marker carries no
 *     rubric text, and this schema requires one; author essays via the UI
 *     or CSV instead, both of which have a rubric column/field.
 *   - HTML-formatted question text — passed through as literal text
 *     (not stripped, not rendered).
 */

import type { ParsedQuestionRow } from "@/lib/questions/import/types";
import type { QuestionBody } from "@/lib/questions/types";

const CATEGORY_LINE = /^\$CATEGORY\s*:\s*(.+)$/i;
const TITLE_PREFIX = /^::[^:]*::/;

function unescapeGift(text: string): string {
  return text.replace(/\\([:~=#{}])/g, "$1");
}

/** Splits raw GIFT text into blocks separated by blank lines, first stripping comment lines and extracting $CATEGORY directives. */
function splitBlocksWithCategories(raw: string): { blockLines: string[]; categoryPath: string[] }[] {
  const lines = raw.split(/\r\n|\r|\n/);
  const blocks: { blockLines: string[]; categoryPath: string[] }[] = [];
  let current: string[] = [];
  let currentCategory: string[] = [];

  function flush() {
    if (current.length > 0) {
      blocks.push({ blockLines: current, categoryPath: currentCategory });
      current = [];
    }
  }

  for (const rawLine of lines) {
    const line = rawLine;
    if (line.trim().startsWith("//")) continue; // comment line, discarded

    const categoryMatch = CATEGORY_LINE.exec(line.trim());
    if (categoryMatch) {
      flush();
      currentCategory = categoryMatch[1]
        .split("/")
        .map((c) => c.trim())
        .filter((c) => c.length > 0);
      continue;
    }

    if (line.trim() === "") {
      flush();
    } else {
      current.push(line);
    }
  }
  flush();
  return blocks;
}

/** Splits GIFT choice-body content into entries on top-level `~`/`=` markers, respecting `\~`/`\=` escapes. Each entry keeps its leading marker character. */
function splitChoiceEntries(inner: string): string[] {
  const entries: string[] = [];
  let current = "";
  for (let i = 0; i < inner.length; i++) {
    const char = inner[i];
    if (char === "\\" && i + 1 < inner.length) {
      current += char + inner[i + 1];
      i++;
      continue;
    }
    if ((char === "~" || char === "=") && current.trim() !== "") {
      entries.push(current.trim());
      current = char;
    } else if ((char === "~" || char === "=") && current.trim() === "") {
      current = char;
    } else {
      current += char;
    }
  }
  if (current.trim() !== "") entries.push(current.trim());
  return entries;
}

/** Strips a trailing `# feedback` segment (feedback is parsed out and discarded, per this parser's documented scope). Also detects (without stripping) a `%NN%` weight prefix so callers can reject it. */
function parseChoiceEntry(entry: string): { marker: "~" | "="; text: string; hasWeight: boolean } {
  const marker = entry[0] as "~" | "=";
  let rest = entry.slice(1);

  // Strip feedback (# ...) — discarded, not preserved anywhere.
  const feedbackIdx = findUnescaped(rest, "#");
  if (feedbackIdx !== -1) {
    rest = rest.slice(0, feedbackIdx);
  }

  const weightMatch = /^%-?\d+(\.\d+)?%/.exec(rest.trim());
  const hasWeight = Boolean(weightMatch);
  if (hasWeight) {
    rest = rest.trim().slice(weightMatch![0].length);
  }

  return { marker, text: unescapeGift(rest.trim()), hasWeight };
}

function findUnescaped(text: string, char: string): number {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\") {
      i++;
      continue;
    }
    if (text[i] === char) return i;
  }
  return -1;
}

/** Finds the `{...}` answer block in a GIFT item, respecting escaped braces. Returns [beforeText, innerContent, afterText] or null if no unescaped `{}` pair is found. */
function extractBraces(text: string): [string, string, string] | null {
  const openIdx = findUnescaped(text, "{");
  if (openIdx === -1) return null;
  // Find matching close brace, respecting escapes (GIFT answer blocks don't nest).
  let closeIdx = -1;
  for (let i = openIdx + 1; i < text.length; i++) {
    if (text[i] === "\\") {
      i++;
      continue;
    }
    if (text[i] === "}") {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) return null;
  return [text.slice(0, openIdx), text.slice(openIdx + 1, closeIdx), text.slice(closeIdx + 1)];
}

export function parseGift(raw: string): ParsedQuestionRow[] {
  const blocks = splitBlocksWithCategories(raw);

  return blocks.map(({ blockLines, categoryPath }, i) => {
    const itemNumber = i + 1;
    const errors: string[] = [];

    let text = blockLines.join(" ").trim();
    text = text.replace(TITLE_PREFIX, "").trim();

    const extracted = extractBraces(text);
    if (!extracted) {
      return {
        itemNumber,
        type: null,
        prompt: unescapeGift(text),
        body: null,
        difficulty: "medium" as const,
        tags: [],
        categoryPath,
        errors: ["No {answer} block found."],
      };
    }

    const [before, inner, after] = extracted;
    const prompt = unescapeGift(`${before}${after}`.trim());
    if (!prompt) errors.push("Missing question prompt.");

    const innerTrimmed = inner.trim();
    let body: QuestionBody | null = null;
    let type: ParsedQuestionRow["type"] = null;

    if (/^(TRUE|FALSE|T|F)$/i.test(innerTrimmed)) {
      const isTrue = /^(TRUE|T)$/i.test(innerTrimmed);
      type = "true_false";
      body = { type: "true_false", value: { correct: isTrue, marks: 1 } };
    } else if (innerTrimmed.startsWith("#")) {
      // Numeric: {#answer} or {#answer:tolerance} or {#answer:tolerance#feedback}
      const numericBody = innerTrimmed.slice(1);
      const withoutFeedback = numericBody.split(/(?<!\\)#/)[0];
      const [valuePart, tolerancePart] = withoutFeedback.split(":").map((s) => s.trim());
      const value = Number(valuePart);
      const tolerance = tolerancePart ? Number(tolerancePart) : 0;
      if (!valuePart || Number.isNaN(value) || Number.isNaN(tolerance)) {
        errors.push(`Could not parse numeric answer from "{${innerTrimmed}}".`);
      } else {
        type = "numeric";
        body = { type: "numeric", value: { correct: value, tolerance, marks: 1 } };
      }
    } else if (innerTrimmed === "") {
      errors.push("Empty {} answer block (essay-style GIFT items are not supported — use the editor UI or CSV, both of which have a rubric field).");
    } else {
      // Multiple choice or short answer: split on ~ and = markers.
      const rawEntries = splitChoiceEntries(innerTrimmed);
      if (rawEntries.length === 0) {
        errors.push(`Could not parse answer block "{${innerTrimmed}}".`);
      } else {
        const parsedEntries = rawEntries.map(parseChoiceEntry);
        const hasTilde = parsedEntries.some((e) => e.marker === "~");
        const hasWeight = parsedEntries.some((e) => e.hasWeight);

        if (hasWeight) {
          errors.push("Per-option weights (%NN%) are not supported by this importer — this schema has no partial-credit model for mcq options.");
        } else if (!hasTilde) {
          // Only `=` entries -> short_answer, all entries accepted.
          const accepted = parsedEntries.map((e) => e.text);
          type = "short_answer";
          body = { type: "short_answer", value: { accepted, caseSensitive: false, marks: 1 } };
        } else {
          // Mixture of ~ and = -> multiple choice.
          const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
          const options = parsedEntries.map((e, oi) => ({ id: letters[oi] ?? `opt-${oi}`, text: e.text }));
          const correctIds = parsedEntries
            .map((e, oi) => (e.marker === "=" ? (letters[oi] ?? `opt-${oi}`) : null))
            .filter((id): id is string => id !== null);
          if (correctIds.length === 0) {
            errors.push("Multiple choice item has no correct (=) option.");
          } else {
            type = correctIds.length === 1 ? "mcq_single" : "mcq_multi";
            body = { type, value: { options, correct: correctIds, marks: 1 } };
          }
        }
      }
    }

    return {
      itemNumber,
      type: body ? type : null,
      prompt,
      body,
      difficulty: "medium" as const,
      tags: [],
      categoryPath,
      errors,
    };
  });
}

export const GIFT_TEMPLATE = [
  "$CATEGORY: Geography",
  "",
  "::Capital of Ghana::What is the capital of Ghana?{",
  "  =Accra",
  "  ~Kumasi",
  "  ~Tamale",
  "}",
  "",
  "The sky is blue during a clear day.{TRUE}",
  "",
  "What is the acceleration due to gravity in m/s^2?{#9.8:0.2}",
  "",
  "Name a primary color.{=Red =Blue =Yellow}",
  "",
].join("\n");
