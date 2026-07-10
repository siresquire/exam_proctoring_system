import { createAdminClient } from "@/lib/supabase/admin";
import type { UserRole } from "@/lib/supabase/types";

const ROLES: UserRole[] = ["super_admin", "admin", "lecturer", "student"];
const EXAM_STATUSES = ["draft", "published", "closed"] as const;
const ATTEMPT_STATUSES = ["in_progress", "submitted", "auto_submitted", "graded", "terminated"] as const;
const SESSION_STATUSES = ["active", "ended", "abandoned", "terminated"] as const;

export interface PlatformAnalytics {
  totalUsers: number;
  activeExams: number;
  attemptsToday: number;
  pendingReports: number;
  usersByRole: Record<UserRole, number>;
  examsByStatus: Record<string, number>;
  attemptsByStatus: Record<string, number>;
  sessionsByStatus: Record<string, number>;
  /** Last 30 days, oldest first, zero-filled for days with no activity. */
  activityByDay: { date: string; value: number }[];
}

async function countRows(
  admin: NonNullable<ReturnType<typeof createAdminClient>>,
  table: Parameters<typeof admin.from>[0],
  filter?: { column: string; value: string },
  gte?: { column: string; value: string },
): Promise<number> {
  let query = admin.from(table).select("*", { count: "exact", head: true });
  if (filter) query = query.eq(filter.column, filter.value);
  if (gte) query = query.gte(gte.column, gte.value);
  const { count, error } = await query;
  if (error) return -1;
  return count ?? 0;
}

/**
 * Platform-wide aggregates for the super-admin/admin dashboards' analytics
 * section. Mirrors app/dashboard/system/page.tsx's service-role aggregate
 * pattern exactly (same countRows shape, same table set) — service-role
 * reads happen server-side only, never forwarded to the browser as raw rows,
 * only as these summed/bucketed counts.
 */
export async function getPlatformAnalytics(): Promise<PlatformAnalytics | null> {
  const admin = createAdminClient();
  if (!admin) return null;

  const startOfToday = new Date();
  startOfToday.setUTCHours(0, 0, 0, 0);

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setUTCDate(thirtyDaysAgo.getUTCDate() - 29);
  thirtyDaysAgo.setUTCHours(0, 0, 0, 0);

  const [
    usersByRole,
    examsByStatus,
    attemptsByStatus,
    sessionsByStatus,
    pendingReports,
    attemptsToday,
    activityRows,
  ] = await Promise.all([
    Promise.all(ROLES.map(async (role) => [role, await countRows(admin, "profiles", { column: "role", value: role })] as const)),
    Promise.all(EXAM_STATUSES.map(async (status) => [status, await countRows(admin, "exams", { column: "status", value: status })] as const)),
    Promise.all(
      ATTEMPT_STATUSES.map(async (status) => [status, await countRows(admin, "exam_attempts", { column: "status", value: status })] as const),
    ),
    Promise.all(
      SESSION_STATUSES.map(async (status) => [status, await countRows(admin, "proctor_sessions", { column: "status", value: status })] as const),
    ),
    countRows(admin, "proctor_reports", { column: "status", value: "pending_review" }),
    countRows(admin, "exam_attempts", undefined, { column: "started_at", value: startOfToday.toISOString() }),
    admin
      .from("audit_log")
      .select("created_at")
      .gte("created_at", thirtyDaysAgo.toISOString())
      .order("created_at", { ascending: true }),
  ]);

  const usersByRoleMap = Object.fromEntries(usersByRole) as Record<UserRole, number>;
  const examsByStatusMap = Object.fromEntries(examsByStatus);

  // Zero-fill every day in the 30-day window so the chart never silently
  // drops a quiet day — a bucket with 0 entries is real information (no
  // privileged activity that day), not a gap in the axis.
  const dayBuckets = new Map<string, number>();
  for (let i = 0; i < 30; i++) {
    const d = new Date(thirtyDaysAgo);
    d.setUTCDate(d.getUTCDate() + i);
    dayBuckets.set(d.toISOString().slice(0, 10), 0);
  }
  for (const row of activityRows.data ?? []) {
    const day = row.created_at.slice(0, 10);
    if (dayBuckets.has(day)) {
      dayBuckets.set(day, (dayBuckets.get(day) ?? 0) + 1);
    }
  }
  const activityByDay = Array.from(dayBuckets.entries()).map(([date, value]) => ({
    date: new Date(`${date}T00:00:00.000Z`).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    value,
  }));

  return {
    totalUsers: ROLES.reduce((sum, role) => sum + Math.max(usersByRoleMap[role] ?? 0, 0), 0),
    activeExams: Math.max(examsByStatusMap["published"] ?? 0, 0),
    attemptsToday: Math.max(attemptsToday, 0),
    pendingReports: Math.max(pendingReports, 0),
    usersByRole: usersByRoleMap,
    examsByStatus: examsByStatusMap,
    attemptsByStatus: Object.fromEntries(attemptsByStatus),
    sessionsByStatus: Object.fromEntries(sessionsByStatus),
    activityByDay,
  };
}
