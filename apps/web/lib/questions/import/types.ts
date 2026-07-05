/**
 * Phase 3b bulk import: shared shapes for the three format parsers
 * (csv.ts, aiken.ts, gift.ts) and the server-side re-validation step
 * (app/dashboard/lecturer/question-banks/[id]/import/actions.ts).
 *
 * Same "never trust the client" posture as Phase 3a's roster importer
 * (lib/onboarding/roster-csv.ts): each parser is a pure, synchronous
 * function usable identically in the browser (live preview) and on the
 * server (pre-commit re-validation of the same raw text) — there is no
 * "trust the client's parsed rows" path anywhere.
 */

import type { QuestionBody, QuestionDifficulty, QuestionType } from "@/lib/questions/types";

export interface ParsedQuestionRow {
  /** 1-based row/item number within the pasted text, for the preview table and error messages. */
  itemNumber: number;
  type: QuestionType | null;
  prompt: string;
  /** Populated when `type` parsed successfully; used to build the create_question `body` argument. */
  body: QuestionBody | null;
  difficulty: QuestionDifficulty;
  tags: string[];
  /** Category path like "Topic/Subtopic" — categories are created as needed on commit. Empty = uncategorized. */
  categoryPath: string[];
  /** Set (non-empty) when this row is invalid — the preview shows it and it is excluded from commit. */
  errors: string[];
}

export function isValidRow(row: ParsedQuestionRow): boolean {
  return row.errors.length === 0 && row.type !== null && row.body !== null && row.prompt.trim() !== "";
}

export const DEFAULT_DIFFICULTY: QuestionDifficulty = "medium";
