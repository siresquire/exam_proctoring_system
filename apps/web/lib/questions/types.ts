/**
 * Phase 3b: shared question-authoring types, mirroring the body shapes
 * documented on `question_versions` in
 * supabase/migrations/20260705000010_question_banks.sql. Kept separate from
 * lib/supabase/types.ts (the hand-written DB mirror) because these are
 * richer, discriminated-union shapes used by the editor/import UI — the DB
 * column itself is just `jsonb`.
 */

export type QuestionType = "mcq_single" | "mcq_multi" | "true_false" | "numeric" | "short_answer" | "essay";
export type QuestionDifficulty = "easy" | "medium" | "hard";
export type QuestionStatus = "active" | "retired";

export interface McqOption {
  id: string;
  text: string;
}

export interface McqBody {
  options: McqOption[];
  /** Option ids. Exactly 1 for mcq_single, >=1 for mcq_multi. */
  correct: string[];
  marks: number;
}

export interface TrueFalseBody {
  correct: boolean;
  marks: number;
}

export interface NumericBody {
  correct: number;
  tolerance: number;
  marks: number;
}

export interface ShortAnswerBody {
  accepted: string[];
  caseSensitive: boolean;
  marks: number;
}

export interface EssayBody {
  marks: number;
  rubric: string;
}

/** The `body` jsonb shape, discriminated by `questions.type`. */
export type QuestionBody =
  | { type: "mcq_single" | "mcq_multi"; value: McqBody }
  | { type: "true_false"; value: TrueFalseBody }
  | { type: "numeric"; value: NumericBody }
  | { type: "short_answer"; value: ShortAnswerBody }
  | { type: "essay"; value: EssayBody };

export const QUESTION_TYPE_LABELS: Record<QuestionType, string> = {
  mcq_single: "Multiple choice — single answer",
  mcq_multi: "Multiple choice — multiple answers",
  true_false: "True / False",
  numeric: "Numeric",
  short_answer: "Short answer",
  essay: "Essay",
};

/**
 * Converts editor-shape body objects to the DB's wire shape (snake_case
 * field names, short_answer's case_sensitive spelled with an underscore per
 * the SQL comment) for the create_question/add_question_version RPC calls.
 * Returns a plain JSON-serializable object — callers pass it straight as
 * the RPC's `body jsonb` argument (typed `Json` in lib/supabase/types.ts).
 */
export function bodyToWireShape(body: QuestionBody): Record<string, unknown> {
  switch (body.type) {
    case "mcq_single":
    case "mcq_multi":
      return { options: body.value.options, correct: body.value.correct, marks: body.value.marks };
    case "true_false":
      return { correct: body.value.correct, marks: body.value.marks };
    case "numeric":
      return { correct: body.value.correct, tolerance: body.value.tolerance, marks: body.value.marks };
    case "short_answer":
      return {
        accepted: body.value.accepted,
        case_sensitive: body.value.caseSensitive,
        marks: body.value.marks,
      };
    case "essay":
      return { marks: body.value.marks, rubric: body.value.rubric };
  }
}

/** Converts a DB jsonb body (wire shape) back into the editor's typed shape, given the question's type. */
export function wireShapeToBody(type: QuestionType, raw: Record<string, unknown> | null | undefined): QuestionBody {
  const r = raw ?? {};
  switch (type) {
    case "mcq_single":
    case "mcq_multi":
      return {
        type,
        value: {
          options: Array.isArray(r.options) ? (r.options as McqOption[]) : [],
          correct: Array.isArray(r.correct) ? (r.correct as string[]) : [],
          marks: typeof r.marks === "number" ? r.marks : 1,
        },
      };
    case "true_false":
      return { type, value: { correct: r.correct === true, marks: typeof r.marks === "number" ? r.marks : 1 } };
    case "numeric":
      return {
        type,
        value: {
          correct: typeof r.correct === "number" ? r.correct : Number(r.correct ?? 0),
          tolerance: typeof r.tolerance === "number" ? r.tolerance : Number(r.tolerance ?? 0),
          marks: typeof r.marks === "number" ? r.marks : 1,
        },
      };
    case "short_answer":
      return {
        type,
        value: {
          accepted: Array.isArray(r.accepted) ? (r.accepted as string[]) : [],
          caseSensitive: r.case_sensitive === true,
          marks: typeof r.marks === "number" ? r.marks : 1,
        },
      };
    case "essay":
      return {
        type,
        value: { marks: typeof r.marks === "number" ? r.marks : 1, rubric: typeof r.rubric === "string" ? r.rubric : "" },
      };
  }
}

/** A freshly-minted client-side option id, for adding a new MCQ option row. Not a DB id — just needs to be unique within the question. */
export function newOptionId(existing: McqOption[]): string {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  for (const letter of letters) {
    if (!existing.some((o) => o.id === letter)) return letter;
  }
  return `opt-${existing.length + 1}`;
}
