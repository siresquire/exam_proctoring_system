/**
 * Phase 3b CSV/TSV bulk import parser. Dependency-free by design (ponytail:
 * same call as lib/onboarding/roster-csv.ts — no CSV library in
 * package.json, and the template is a fixed, documented column set), reusing
 * that file's quoted-field splitting approach.
 *
 * Template columns (header required, order-independent, case-insensitive):
 *   type, prompt, options, correct, difficulty, tags, marks, category
 *
 *   - type: mcq_single | mcq_multi | true_false | numeric | short_answer | essay
 *   - prompt: the question text
 *   - options: pipe- or semicolon-separated list, e.g. "Paris|London|Rome" (mcq only)
 *   - correct: for mcq — 1-based option INDICES ("1" or "1,3") or LETTERS
 *     ("A" or "A,C"); for true_false — "true"/"false"; for numeric — the
 *     numeric answer, optionally "value:tolerance" e.g. "9.8:0.1"; for
 *     short_answer — accepted answers, pipe- or semicolon-separated; unused
 *     for essay.
 *   - difficulty: easy | medium | hard (default medium if blank)
 *   - tags: comma-separated
 *   - marks: positive number (default 1 if blank)
 *   - category: a path like "Topic/Subtopic" (created as needed on commit);
 *     blank = uncategorized
 */

import type { ParsedQuestionRow } from "@/lib/questions/import/types";
import type { QuestionBody, QuestionDifficulty, QuestionType } from "@/lib/questions/types";

export const CSV_TEMPLATE_HEADER = "type,prompt,options,correct,difficulty,tags,marks,category";
export const CSV_TEMPLATE_EXAMPLE_ROWS = [
  "mcq_single,What is the capital of Ghana?,Accra|Kumasi|Tamale,1,easy,geography,1,Geography/Ghana",
  "true_false,The sun rises in the west.,,false,easy,astronomy,1,Science",
  "numeric,What is the acceleration due to gravity (m/s^2)?,,9.8:0.2,medium,physics,2,Science/Physics",
  "short_answer,Name the largest planet in the solar system.,,Jupiter,medium,astronomy,1,Science",
  "essay,Discuss the causes of the French Revolution.,,,hard,history,10,History",
];
export const CSV_TEMPLATE = `${CSV_TEMPLATE_HEADER}\n${CSV_TEMPLATE_EXAMPLE_ROWS.join("\n")}\n`;

const VALID_TYPES: QuestionType[] = ["mcq_single", "mcq_multi", "true_false", "numeric", "short_answer", "essay"];
const VALID_DIFFICULTIES: QuestionDifficulty[] = ["easy", "medium", "hard"];

/** Splits one CSV/TSV line into fields, honoring double-quoted fields (with "" as an escaped quote). Same algorithm as lib/onboarding/roster-csv.ts's splitCsvLine. */
function splitDelimitedLine(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      fields.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields.map((f) => f.trim());
}

function splitList(raw: string): string[] {
  return raw
    .split(/[|;]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Resolves a "correct" spec (indices like "1,3" or letters like "A,C") against a parsed option list. Returns option ids (letters A, B, C, ...) or null if unresolvable. */
function resolveCorrectOptionIds(spec: string, optionCount: number): string[] | null {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const parts = spec
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) return null;

  const ids: string[] = [];
  for (const part of parts) {
    if (/^\d+$/.test(part)) {
      const idx = Number(part) - 1; // 1-based index
      if (idx < 0 || idx >= optionCount) return null;
      ids.push(letters[idx]);
    } else if (/^[A-Za-z]$/.test(part)) {
      const idx = letters.indexOf(part.toUpperCase());
      if (idx < 0 || idx >= optionCount) return null;
      ids.push(letters[idx]);
    } else {
      return null;
    }
  }
  return ids;
}

function detectDelimiter(headerLine: string): string {
  return headerLine.includes("\t") ? "\t" : ",";
}

/** Parses raw CSV/TSV text into rows, applying the same per-row validation the preview and server commit both need. Pure/synchronous — usable on the client for the live preview and re-run verbatim on the server before commit. */
export function parseQuestionCsv(raw: string): ParsedQuestionRow[] {
  const lines = raw.split(/\r\n|\r|\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];

  const delimiter = detectDelimiter(lines[0]);
  const header = splitDelimitedLine(lines[0], delimiter).map((h) => h.toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const idx = {
    type: col("type"),
    prompt: col("prompt"),
    options: col("options"),
    correct: col("correct"),
    difficulty: col("difficulty"),
    tags: col("tags"),
    marks: col("marks"),
    category: col("category"),
  };

  const hasRecognizedHeader = idx.type !== -1 && idx.prompt !== -1;
  const dataLines = hasRecognizedHeader ? lines.slice(1) : lines;

  return dataLines.map((line, i) => {
    const fields = splitDelimitedLine(line, delimiter);
    const get = (i2: number) => (i2 >= 0 ? (fields[i2] ?? "").trim() : "");

    const itemNumber = i + 1;
    const errors: string[] = [];

    const rawType = get(idx.type).toLowerCase();
    const type = (VALID_TYPES as string[]).includes(rawType) ? (rawType as QuestionType) : null;
    if (!type) errors.push(`Unknown or missing type "${get(idx.type)}".`);

    const prompt = get(idx.prompt);
    if (!prompt) errors.push("Prompt is required.");

    const rawDifficulty = get(idx.difficulty).toLowerCase();
    const difficulty: QuestionDifficulty = (VALID_DIFFICULTIES as string[]).includes(rawDifficulty)
      ? (rawDifficulty as QuestionDifficulty)
      : "medium";
    if (get(idx.difficulty) && !(VALID_DIFFICULTIES as string[]).includes(rawDifficulty)) {
      errors.push(`Unknown difficulty "${get(idx.difficulty)}", defaulting to medium.`);
    }

    const tags = get(idx.tags)
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

    const categoryPath = get(idx.category)
      .split("/")
      .map((c) => c.trim())
      .filter((c) => c.length > 0);

    const marksRaw = get(idx.marks);
    const marks = marksRaw ? Number(marksRaw) : 1;
    if (marksRaw && (Number.isNaN(marks) || marks <= 0)) {
      errors.push(`Marks must be a positive number, got "${marksRaw}".`);
    }

    let body: QuestionBody | null = null;

    if (type === "mcq_single" || type === "mcq_multi") {
      const optionTexts = splitList(get(idx.options));
      if (optionTexts.length < 2) {
        errors.push("mcq questions require at least 2 options.");
      } else {
        const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
        const options = optionTexts.map((text, oi) => ({ id: letters[oi] ?? `opt-${oi}`, text }));
        const correctIds = resolveCorrectOptionIds(get(idx.correct), optionTexts.length);
        if (!correctIds) {
          errors.push(`Could not resolve "correct" (${get(idx.correct) || "blank"}) against ${optionTexts.length} options.`);
        } else if (type === "mcq_single" && correctIds.length !== 1) {
          errors.push("mcq_single requires exactly 1 correct option.");
        } else {
          body = { type, value: { options, correct: correctIds, marks: marks > 0 ? marks : 1 } };
        }
      }
    } else if (type === "true_false") {
      const correctRaw = get(idx.correct).toLowerCase();
      if (correctRaw !== "true" && correctRaw !== "false") {
        errors.push(`true_false "correct" must be true/false, got "${get(idx.correct)}".`);
      } else {
        body = { type, value: { correct: correctRaw === "true", marks: marks > 0 ? marks : 1 } };
      }
    } else if (type === "numeric") {
      const [valuePart, tolerancePart] = get(idx.correct).split(":").map((s) => s.trim());
      const value = Number(valuePart);
      const tolerance = tolerancePart ? Number(tolerancePart) : 0;
      if (!valuePart || Number.isNaN(value) || Number.isNaN(tolerance)) {
        errors.push(`numeric "correct" must be a number, optionally "value:tolerance", got "${get(idx.correct)}".`);
      } else {
        body = { type, value: { correct: value, tolerance, marks: marks > 0 ? marks : 1 } };
      }
    } else if (type === "short_answer") {
      const accepted = splitList(get(idx.correct));
      if (accepted.length === 0) {
        errors.push("short_answer requires at least 1 accepted answer in the correct column.");
      } else {
        body = { type, value: { accepted, caseSensitive: false, marks: marks > 0 ? marks : 1 } };
      }
    } else if (type === "essay") {
      body = { type, value: { marks: marks > 0 ? marks : 1, rubric: "" } };
    }

    return {
      itemNumber,
      type,
      prompt,
      body,
      difficulty,
      tags,
      categoryPath,
      errors,
    };
  });
}
