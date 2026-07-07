import { notFound } from "next/navigation";

import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Breadcrumbs } from "@/components/layout/breadcrumbs";
import { FormsExamForm } from "@/components/forms/forms-exam-form";

export default async function EditFormsExamPage({ params }: { params: Promise<{ id: string }> }) {
  await requireRole("lecturer", "admin");
  const { id } = await params;

  const supabase = await createClient();
  const { data: exam } = supabase
    ? await supabase.from("forms_exams").select("*").eq("id", id).maybeSingle()
    : { data: null };

  if (!exam) {
    notFound();
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <Breadcrumbs
        items={[
          { label: "Dashboard", href: "/dashboard" },
          { label: "Google Forms quizzes", href: "/dashboard/lecturer/forms-exams" },
          { label: exam.title ?? "Edit quiz" },
        ]}
      />
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Edit Google Forms quiz</h1>
        <p className="text-muted-foreground mt-2 max-w-2xl">
          Status: <span className="font-medium">{exam.status}</span>. Changes save immediately to
          this exam&apos;s configuration; publishing/closing are separate actions from the list.
        </p>
      </header>
      <FormsExamForm existing={exam} />
    </div>
  );
}
