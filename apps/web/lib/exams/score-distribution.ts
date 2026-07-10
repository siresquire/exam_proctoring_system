import type { ExamResultRow } from "@/lib/supabase/types";

export const SCORE_BUCKETS = ["0-49", "50-59", "60-69", "70-79", "80-100"] as const;
export type ScoreBucket = (typeof SCORE_BUCKETS)[number];

const GRADED_STATUSES = new Set(["submitted", "auto_submitted", "terminated", "graded"]);

function bucketFor(pct: number): ScoreBucket {
  if (pct < 50) return "0-49";
  if (pct < 60) return "50-59";
  if (pct < 70) return "60-69";
  if (pct < 80) return "70-79";
  return "80-100";
}

/**
 * Buckets a set of exam_results() rows into a score-distribution histogram,
 * client/server-shared so the per-exam results page can reuse the exact same
 * rule the lecturer_dashboard_stats() RPC applies: only attempts with a
 * finalized score count (the same status set get_attempt_result treats as
 * "released-eligible": submitted/auto_submitted/terminated/graded) AND
 * needs_manual_grading = false, so a still-partially-graded essay attempt
 * never shows a misleadingly low score.
 */
export function bucketScoreDistribution(
  rows: Pick<ExamResultRow, "status" | "auto_score" | "max_score" | "needs_manual_grading">[],
): { category: ScoreBucket; value: number }[] {
  const counts = Object.fromEntries(SCORE_BUCKETS.map((b) => [b, 0])) as Record<ScoreBucket, number>;

  for (const row of rows) {
    if (row.needs_manual_grading) continue;
    if (!GRADED_STATUSES.has(row.status)) continue;
    if (row.max_score == null || row.max_score <= 0 || row.auto_score == null) continue;
    counts[bucketFor((row.auto_score / row.max_score) * 100)] += 1;
  }

  return SCORE_BUCKETS.map((category) => ({ category, value: counts[category] }));
}
