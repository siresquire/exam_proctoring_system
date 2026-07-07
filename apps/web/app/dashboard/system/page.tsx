import { requireRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { SystemOverview, type SystemCounts } from "@/components/admin/system-overview";
import type { UserRole } from "@/lib/supabase/types";

const ROLES: UserRole[] = ["super_admin", "admin", "lecturer", "student"];
const EXAM_STATUSES = ["draft", "published", "closed"] as const;
const ATTEMPT_STATUSES = ["in_progress", "submitted", "auto_submitted", "graded", "terminated"] as const;
const SESSION_STATUSES = ["active", "ended", "abandoned", "terminated"] as const;

async function countRows(
  admin: NonNullable<ReturnType<typeof createAdminClient>>,
  table: Parameters<typeof admin.from>[0],
  filter?: { column: string; value: string },
): Promise<number> {
  let query = admin.from(table).select("*", { count: "exact", head: true });
  if (filter) {
    query = query.eq(filter.column, filter.value);
  }
  const { count, error } = await query;
  if (error) return -1;
  return count ?? 0;
}

export default async function SystemOverviewPage() {
  await requireRole("super_admin");

  const admin = createAdminClient();
  if (!admin) {
    return (
      <SystemOverview
        counts={null}
        keepalive={null}
        loadError="Supabase service-role key is not configured in this environment — counts cannot be computed."
      />
    );
  }

  const [
    usersByRole,
    classesCount,
    banksCount,
    questionsCount,
    examsByStatus,
    attemptsByStatus,
    sessionsByStatus,
    pendingReportsCount,
    mediaCount,
  ] = await Promise.all([
    Promise.all(ROLES.map(async (role) => [role, await countRows(admin, "profiles", { column: "role", value: role })] as const)),
    countRows(admin, "classes"),
    countRows(admin, "question_banks"),
    countRows(admin, "questions"),
    Promise.all(EXAM_STATUSES.map(async (status) => [status, await countRows(admin, "exams", { column: "status", value: status })] as const)),
    Promise.all(
      ATTEMPT_STATUSES.map(async (status) => [status, await countRows(admin, "exam_attempts", { column: "status", value: status })] as const),
    ),
    Promise.all(
      SESSION_STATUSES.map(async (status) => [status, await countRows(admin, "proctor_sessions", { column: "status", value: status })] as const),
    ),
    countRows(admin, "proctor_reports", { column: "status", value: "pending_review" }),
    countRows(admin, "proctor_media"),
  ]);

  const { data: keepaliveRow } = await admin.from("keepalive").select("pinged_at").eq("id", 1).maybeSingle();

  const counts: SystemCounts = {
    usersByRole: Object.fromEntries(usersByRole) as Record<UserRole, number>,
    classesCount,
    banksCount,
    questionsCount,
    examsByStatus: Object.fromEntries(examsByStatus),
    attemptsByStatus: Object.fromEntries(attemptsByStatus),
    sessionsByStatus: Object.fromEntries(sessionsByStatus),
    pendingReportsCount,
    mediaCount,
  };

  return <SystemOverview counts={counts} keepalive={keepaliveRow?.pinged_at ?? null} />;
}
