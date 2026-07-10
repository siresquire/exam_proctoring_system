import { ClipboardList, FileText, ShieldAlert } from "lucide-react";

import { StatTile } from "@/components/charts/stat-tile";
import { BarChartCard } from "@/components/charts/bar-chart-card";
import { StatusBarChartCard, type StatusBarChartDatum } from "@/components/charts/status-bar-chart-card";
import { SCORE_BUCKETS } from "@/lib/exams/score-distribution";
import type { LecturerDashboardStats } from "@/lib/supabase/types";

const EXAM_STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  published: "Published",
  closed: "Closed",
};

const ATTEMPT_STATUS_LABELS: Record<string, string> = {
  in_progress: "In progress",
  submitted: "Submitted",
  auto_submitted: "Auto-submitted",
  graded: "Graded",
  terminated: "Terminated",
};

const SEVERITY: { key: string; label: string; status: StatusBarChartDatum["status"] }[] = [
  { key: "info", label: "Info", status: "good" },
  { key: "low", label: "Low", status: "warning" },
  { key: "medium", label: "Medium", status: "serious" },
  { key: "high", label: "High", status: "critical" },
];

function sumValues(record: Record<string, number>): number {
  return Object.values(record).reduce((sum, n) => sum + (n ?? 0), 0);
}

interface LecturerAnalyticsSectionProps {
  stats: LecturerDashboardStats;
}

/**
 * Lecturer dashboard analytics — aggregates across the caller's OWN exams
 * only (lecturer_dashboard_stats() RPC, owner-scoped, re-derives authority
 * server-side). Score distribution here is the SAME bucketing rule as the
 * per-exam results page (lib/exams/score-distribution.ts's GRADED_STATUSES
 * set), just aggregated platform-wide across the lecturer's own exams.
 */
export function LecturerAnalyticsSection({ stats }: LecturerAnalyticsSectionProps) {
  const examsByStatusData = Object.entries(EXAM_STATUS_LABELS).map(([key, label]) => ({
    category: label,
    value: stats.exams_by_status[key] ?? 0,
  }));

  const attemptsByStatusData = Object.entries(ATTEMPT_STATUS_LABELS).map(([key, label]) => ({
    category: label,
    value: stats.attempts_by_status[key] ?? 0,
  }));

  const scoreDistributionData = SCORE_BUCKETS.map((bucket) => ({
    category: bucket,
    value: stats.score_distribution[bucket] ?? 0,
  }));

  const flagsBySeverityData: StatusBarChartDatum[] = SEVERITY.map(({ key, label, status }) => ({
    category: label,
    value: stats.flags_by_severity[key] ?? 0,
    status,
  }));

  const totalExams = sumValues(stats.exams_by_status);
  const totalAttempts = sumValues(stats.attempts_by_status);
  const totalFlags = sumValues(stats.flags_by_severity);

  return (
    <section aria-labelledby="lecturer-analytics-heading" className="mx-auto mb-10 max-w-6xl px-4 sm:px-6">
      <h2 id="lecturer-analytics-heading" className="mb-4 text-lg font-medium tracking-tight">
        Your teaching analytics
      </h2>

      <div className="mb-4 grid gap-4 sm:grid-cols-3">
        <StatTile label="Your exams" value={totalExams.toLocaleString()} icon={FileText} />
        <StatTile label="Attempts received" value={totalAttempts.toLocaleString()} icon={ClipboardList} />
        <StatTile
          label="Integrity flags"
          value={totalFlags.toLocaleString()}
          icon={ShieldAlert}
          status={totalFlags > 0 ? "warning" : "good"}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <BarChartCard
          title="Exams by status"
          data={examsByStatusData}
          valueLabel="Exams"
          emptyMessage="Create an exam to see this chart populate."
        />
        <BarChartCard
          title="Attempts by status"
          data={attemptsByStatusData}
          valueLabel="Attempts"
          emptyMessage="No attempts yet."
        />
        <BarChartCard
          title="Score distribution"
          description="Fully-graded attempts across all your exams, by percentage bucket."
          data={scoreDistributionData}
          valueLabel="Attempts"
          emptyMessage="No fully-graded attempts yet."
        />
        <StatusBarChartCard
          title="Integrity flags by severity"
          description="Proctoring events across your exams' sessions."
          data={flagsBySeverityData}
          valueLabel="Events"
          emptyMessage="No proctoring events recorded yet."
        />
      </div>
    </section>
  );
}
