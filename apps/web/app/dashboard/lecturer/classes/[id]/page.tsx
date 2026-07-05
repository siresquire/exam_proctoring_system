import { notFound } from "next/navigation";

import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { ClassDetail } from "@/components/onboarding/class-detail";
import type { ClassRosterRow, ClassRow } from "@/lib/supabase/types";

export default async function ClassDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireRole("lecturer", "admin");
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

  return <ClassDetail klass={klass} roster={(roster ?? []) as ClassRosterRow[]} />;
}
