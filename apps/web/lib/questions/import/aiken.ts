/**
 * Phase 3b Aiken format parser — the classic Moodle-compatible plain-text
 * MCQ format:
 *
 *   What is the capital of Ghana?
 *   A. Accra
 *   B. Kumasi
 *   C. Tamale
 *   ANSWER: A
 *
 * Multiple questions are separated by one or more blank lines. Every parsed
 * item is `mcq_single` (Aiken has no notion of multi-answer, true/false, or
 * any other type — that is the documented scope of this format). Supports
 * any number of options (A-Z), not just 4.
 */

import type { ParsedQuestionRow } from "@/lib/questions/import/types";
import type { QuestionBody } from "@/lib/questions/types";

const OPTION_LINE = /^([A-Za-z])[.)]\s+(.*)$/;
const ANSWER_LINE = /^ANSWER\s*:\s*([A-Za-z])\s*$/i;

export const AIKEN_TEMPLATE = [
  "What is the capital of Ghana?",
  "A. Accra",
  "B. Kumasi",
  "C. Tamale",
  "D. Cape Coast",
  "ANSWER: A",
  "",
  "The sky is blue.",
  "A. True",
  "B. False",
  "ANSWER: A",
  "",
].join("\n");

/** Splits raw Aiken text into blocks separated by one or more blank lines. */
function splitBlocks(raw: string): string[][] {
  const lines = raw.split(/\r\n|\r|\n/);
  const blocks: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.trim() === "") {
      if (current.length > 0) {
        blocks.push(current);
        current = [];
      }
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) blocks.push(current);
  return blocks;
}

export function parseAiken(raw: string): ParsedQuestionRow[] {
  const blocks = splitBlocks(raw);

  return blocks.map((blockLines, i) => {
    const itemNumber = i + 1;
    const errors: string[] = [];

    const promptLines: string[] = [];
    const options: { id: string; text: string }[] = [];
    let answerLetter: string | null = null;

    for (const rawLine of blockLines) {
      const line = rawLine.trim();
      const answerMatch = ANSWER_LINE.exec(line);
      if (answerMatch) {
        answerLetter = answerMatch[1].toUpperCase();
        continue;
      }
      const optionMatch = OPTION_LINE.exec(line);
      if (optionMatch) {
        options.push({ id: optionMatch[1].toUpperCase(), text: optionMatch[2].trim() });
      } else if (options.length === 0) {
        promptLines.push(line);
      } else {
        errors.push(`Unrecognized line inside options block: "${line}".`);
      }
    }

    const prompt = promptLines.join(" ").trim();
    if (!prompt) errors.push("Missing question prompt.");
    if (options.length < 2) errors.push(`Found ${options.length} option(s); Aiken requires at least 2 (A., B., ...).`);
    if (!answerLetter) errors.push('Missing "ANSWER: X" line.');

    let body: QuestionBody | null = null;
    if (options.length >= 2 && answerLetter) {
      const matchedOption = options.find((o) => o.id === answerLetter);
      if (!matchedOption) {
        errors.push(`ANSWER "${answerLetter}" does not match any option letter (${options.map((o) => o.id).join(", ")}).`);
      } else {
        body = { type: "mcq_single", value: { options, correct: [matchedOption.id], marks: 1 } };
      }
    }

    return {
      itemNumber,
      type: body ? "mcq_single" : null,
      prompt,
      body,
      difficulty: "medium",
      tags: [],
      categoryPath: [],
      errors,
    };
  });
}
