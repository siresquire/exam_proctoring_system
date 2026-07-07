import { requireRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { AuditLogBrowser } from "@/components/admin/audit-log-browser";
import type { Database } from "@/lib/supabase/types";

const PAGE_SIZE = 50;

type AuditLogRow = Database["public"]["Tables"]["audit_log"]["Row"];

interface AuditPageProps {
  searchParams: Promise<{ page?: string; action?: string }>;
}

export default async function AuditLogPage({ searchParams }: AuditPageProps) {
  await requireRole("admin", "super_admin");

  const params = await searchParams;
  const page = Math.max(1, Number(params.page) || 1);
  const actionFilter = params.action?.trim() || null;

  const supabase = await createClient();
  if (!supabase) {
    return (
      <AuditLogBrowser
        entries={[]}
        actors={{}}
        distinctActions={[]}
        page={1}
        pageCount={1}
        totalCount={0}
        actionFilter={null}
        loadError="Supabase is not configured in this environment."
      />
    );
  }

  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  let query = supabase
    .from("audit_log")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(from, to);
  if (actionFilter) {
    query = query.eq("action", actionFilter);
  }

  const { data: entries, error, count } = await query;

  // Distinct actions for the filter dropdown — a lightweight extra query
  // over just the action column (RLS-scoped the same as the main query).
  const { data: actionRows } = await supabase.from("audit_log").select("action");
  const distinctActions = Array.from(new Set((actionRows ?? []).map((r) => r.action))).sort();

  const actorIds = Array.from(
    new Set((entries ?? []).map((e: AuditLogRow) => e.actor_id).filter((id): id is string => Boolean(id))),
  );

  const actors: Record<string, { fullName: string | null; email: string | null }> = {};
  if (actorIds.length > 0) {
    const { data: profiles } = await supabase.from("profiles").select("id, full_name").in("id", actorIds);
    for (const p of profiles ?? []) {
      actors[p.id] = { fullName: p.full_name, email: null };
    }

    // One getUserById per DISTINCT actor on this page (at most PAGE_SIZE),
    // not per audit row — acceptable fan-out for a 50-row page. Bulk
    // listUsers() would require paginating the whole user base just to
    // resolve a handful of ids, which is worse for a large roster.
    const admin = createAdminClient();
    if (admin) {
      await Promise.all(
        actorIds.map(async (id) => {
          const { data } = await admin.auth.admin.getUserById(id);
          if (data?.user) {
            actors[id] = { fullName: actors[id]?.fullName ?? null, email: data.user.email ?? null };
          }
        }),
      );
    }
  }

  const totalCount = count ?? 0;
  const pageCount = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  return (
    <AuditLogBrowser
      entries={entries ?? []}
      actors={actors}
      distinctActions={distinctActions}
      page={page}
      pageCount={pageCount}
      totalCount={totalCount}
      actionFilter={actionFilter}
      loadError={error?.message}
    />
  );
}
