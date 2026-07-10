/**
 * Phase 3c: shared exam-builder types + small pure helpers, mirroring the
 * pattern of lib/questions/types.ts. Kept separate from lib/supabase/types.ts
 * (the hand-written DB mirror) for the same reason: these are UI-facing
 * shapes, not wire/column shapes.
 */

import type { ExamDraw, ExamResultsRelease } from "@/lib/supabase/types";

export const TIER_LABELS: Record<number, string> = {
  1: "T1 — Quiz (any device, server-side checks only, no camera)",
  2: "T2 — Monitored (webcam + environment signals)",
  3: "T3 — Proctored (adds fullscreen lock + tab/app-switch detection)",
  4: "T4 — High stakes (desktop + Safe Exam Browser — coming soon)",
};

export const RESULTS_RELEASE_LABELS: Record<ExamResultsRelease, string> = {
  immediate: "Immediately after grading",
  after_close: "After the exam closes",
  manual: "Only when I release them manually",
};

export const DIFFICULTY_FILTER_LABELS: Record<string, string> = {
  easy: "Easy",
  medium: "Medium",
  hard: "Hard",
};

export function toDatetimeLocalValue(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function fromDatetimeLocalValue(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

/** Total question count across every section of a preview draw — for the "N questions, M marks" summary line. */
export function drawTotals(draw: ExamDraw | null): { questionCount: number; totalMarks: number } {
  if (!draw) return { questionCount: 0, totalMarks: 0 };
  let questionCount = 0;
  let totalMarks = 0;
  for (const section of draw.sections) {
    for (const q of section.questions) {
      questionCount += 1;
      const marks = (q.body as { marks?: unknown })?.marks;
      if (typeof marks === "number") totalMarks += marks;
    }
  }
  return { questionCount, totalMarks };
}
