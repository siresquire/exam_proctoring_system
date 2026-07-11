import { notFound } from "next/navigation";

import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { ClassDetail } from "@/components/onboarding/class-detail";
import type { ClassRosterRow, ClassRow } from "@/lib/supabase/types";

export default async function ClassDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireRole("lecturer", "admin");
  const { id } = await params;

  const supabase = await createClient();
  if (!supabase) {
    notFound();
  }

  const { data: klass } = await supabase.from("classes").select("*").eq("id", id).maybeSingle<ClassRow>();
  if (!klass) {
    notFound();
  }

  const { data: roster } = await supabase.rpc("class_roster", { class_id: id });

  // Phase 4: account-lifecycle actions (suspend/reactivate/remove) are only
  // rendered when they would actually succeed against set_account_status's
  // matrix — admin/super_admin may act on any class's roster, but a
  // lecturer only on a class they OWN (set_account_status re-checks
  // ownership server-side regardless; this just avoids showing a button
  // that's guaranteed to fail for a lecturer viewing someone else's class).
  const canManageAccounts = session.profile.role !== "lecturer" || klass.owner_id === session.user.id;

  return (
    <ClassDetail
      klass={klass}
      roster={(roster ?? []) as ClassRosterRow[]}
      canManageAccounts={canManageAccounts}
    />
  );
}
