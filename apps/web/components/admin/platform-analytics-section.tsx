import { ClipboardList, ExternalLink, FileWarning, Users2, Zap } from "lucide-react";

import { StatTile } from "@/components/charts/stat-tile";
import { BarChartCard } from "@/components/charts/bar-chart-card";
import { AreaChartCard } from "@/components/charts/area-chart-card";
import { StatusBarChartCard, type StatusBarChartDatum } from "@/components/charts/status-bar-chart-card";
import type { PlatformAnalytics } from "@/lib/admin/platform-analytics";
import type { UserRole } from "@/lib/supabase/types";

const ROLE_LABELS: Record<UserRole, string> = {
  super_admin: "Super admin",
  admin: "Admin",
  lecturer: "Lecturer",
  student: "Student",
};

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

const SESSION_STATUS: { key: string; label: string; status: StatusBarChartDatum["status"] }[] = [
  { key: "active", label: "Active", status: "good" },
  { key: "ended", label: "Ended", status: "good" },
  { key: "abandoned", label: "Abandoned", status: "warning" },
  { key: "terminated", label: "Terminated", status: "critical" },
];

interface PlatformAnalyticsSectionProps {
  analytics: PlatformAnalytics;
}

/**
 * Shared platform analytics — used by both the super-admin dashboard and the
 * admin dashboard (admins are staff, same platform-wide read). Every number
 * here comes from a service-role aggregate computed server-side (see
 * lib/admin/platform-analytics.ts) — never raw rows reaching the browser.
 */
export function PlatformAnalyticsSection({ analytics }: PlatformAnalyticsSectionProps) {
  const usersByRoleData = (Object.keys(ROLE_LABELS) as UserRole[]).map((role) => ({
    category: ROLE_LABELS[role],
    value: analytics.usersByRole[role] ?? 0,
  }));

  const examsByStatusData = Object.entries(EXAM_STATUS_LABELS).map(([key, label]) => ({
    category: label,
    value: analytics.examsByStatus[key] ?? 0,
  }));

  const attemptsByStatusData = Object.entries(ATTEMPT_STATUS_LABELS).map(([key, label]) => ({
    category: label,
    value: analytics.attemptsByStatus[key] ?? 0,
  }));

  const sessionsByStatusData: StatusBarChartDatum[] = SESSION_STATUS.map(({ key, label, status }) => ({
    category: label,
    value: analytics.sessionsByStatus[key] ?? 0,
    status,
  }));

  return (
    <section aria-labelledby="platform-analytics-heading" className="mb-10">
      <h2 id="platform-analytics-heading" className="mb-4 text-lg font-medium tracking-tight">
        Platform analytics
      </h2>

      <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Total users" value={analytics.totalUsers.toLocaleString()} icon={Users2} />
        <StatTile label="Active exams" value={analytics.activeExams.toLocaleString()} icon={Zap} />
        <StatTile label="Attempts today" value={analytics.attemptsToday.toLocaleString()} icon={ClipboardList} />
        <StatTile
          label="Pending proctoring reports"
          value={analytics.pendingReports.toLocaleString()}
          icon={FileWarning}
          status={analytics.pendingReports > 0 ? "warning" : "good"}
          caption={analytics.pendingReports > 0 ? "Awaiting review" : "None awaiting review"}
        />
      </div>

      <div className="mb-4">
        <AreaChartCard
          title="Platform activity, last 30 days"
          description="Audit log entries per day — every privileged action recorded on the platform."
          data={analytics.activityByDay}
          valueLabel="Entries"
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-2">
        <BarChartCard title="Users by role" data={usersByRoleData} valueLabel="Users" />
        <BarChartCard title="Exams by status" data={examsByStatusData} valueLabel="Exams" />
        <BarChartCard title="Exam attempts by status" data={attemptsByStatusData} valueLabel="Attempts" />
        <StatusBarChartCard
          title="Proctoring sessions by status"
          description="Terminated sessions ended because the server-enforced violation limit was reached."
          data={sessionsByStatusData}
          valueLabel="Sessions"
        />
      </div>

      <p className="text-muted-foreground mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        Row counts only — storage/quota usage (database size, file storage, bandwidth) requires each
        provider&apos;s own console; no numbers are fabricated here.
        <a
          href="https://supabase.com/dashboard/project/_/settings/billing/subscription"
          target="_blank"
          rel="noreferrer"
          className="text-primary inline-flex min-h-11 items-center gap-1 font-medium underline-offset-4 hover:underline"
        >
          Supabase usage
          <ExternalLink aria-hidden className="size-3" />
        </a>
        <a
          href="https://dash.cloudflare.com/?to=/:account/r2/overview"
          target="_blank"
          rel="noreferrer"
          className="text-primary inline-flex min-h-11 items-center gap-1 font-medium underline-offset-4 hover:underline"
        >
          Cloudflare R2 usage
          <ExternalLink aria-hidden className="size-3" />
        </a>
      </p>
    </section>
  );
}
