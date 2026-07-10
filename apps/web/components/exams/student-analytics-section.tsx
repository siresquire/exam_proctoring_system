"use client";

import { CalendarClock } from "lucide-react";

import { StatTile } from "@/components/charts/stat-tile";
import { BarChartCard } from "@/components/charts/bar-chart-card";
import type { StudentDashboardStats } from "@/lib/supabase/types";

interface StudentAnalyticsSectionProps {
  stats: StudentDashboardStats;
}

/**
 * "Your results" — student_dashboard_stats() already returns ONLY the
 * caller's own results, and only for exams whose results have actually been
 * released (see the RPC's comment for the exact gate, identical to
 * get_attempt_result). Nothing here needs a further client-side filter —
 * the release-gating and answer-secrecy invariant are enforced entirely in
 * SQL, not re-checked (or re-checkable) here.
 *
 * "use client": this passes a `formatValue` callback into BarChartCard (a
 * client component) — a function prop can only cross the server/client
 * boundary from an ancestor that is ITSELF a client component (React can't
 * serialize a plain function for the wire, only "use server" actions).
 * `stats` itself stays a plain serializable prop handed down from the
 * server page, so nothing here loses the server-side data-fetching this
 * relies on.
 */
export function StudentAnalyticsSection({ stats }: StudentAnalyticsSectionProps) {
  const scoreData = stats.released_results.map((r) => ({
    category: r.exam_title,
    value: r.score_pct,
  }));

  return (
    <section aria-labelledby="student-analytics-heading" className="space-y-4">
      <h2 id="student-analytics-heading" className="text-lg font-semibold tracking-tight">
        Your results
      </h2>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile
          label="Available exams"
          value={stats.upcoming_exams_count.toLocaleString()}
          icon={CalendarClock}
          caption="Open and within your class's exam window"
        />
        <div className="sm:col-span-2">
          <BarChartCard
            title="Score by exam"
            description="Percentage score for each exam whose results have been released to you."
            data={scoreData}
            valueLabel="Score"
            formatValue={(v) => `${v}%`}
            emptyMessage="No released results yet."
          />
        </div>
      </div>
    </section>
  );
}
