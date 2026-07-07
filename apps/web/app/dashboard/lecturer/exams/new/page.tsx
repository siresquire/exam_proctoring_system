import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Breadcrumbs } from "@/components/layout/breadcrumbs";
import { NewExamForm } from "@/components/exams/new-exam-form";
import type { ClassRow } from "@/lib/supabase/types";

export default async function NewExamPage() {
  await requireRole("lecturer", "admin");

  const supabase = await createClient();
  let classes: ClassRow[] = [];
  if (supabase) {
    const { data } = await supabase.from("classes").select("*").order("name");
    classes = data ?? [];
  }

  return (
    <div className="mx-auto max-w-xl px-4 py-10 sm:px-6">
      <Breadcrumbs
        items={[
          { label: "Dashboard", href: "/dashboard" },
          { label: "Exams", href: "/dashboard/lecturer/exams" },
          { label: "New exam" },
        ]}
      />
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">New exam</h1>
        <p className="text-muted-foreground mt-2 max-w-2xl">
          Start with a title. You can assign a class, build sections, and configure scheduling and
          the integrity tier on the next screen.
        </p>
      </header>
      <NewExamForm classes={classes} />
    </div>
  );
}
