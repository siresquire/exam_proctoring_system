import { requireRole } from "@/lib/auth";
import { Breadcrumbs } from "@/components/layout/breadcrumbs";
import { FormsExamForm } from "@/components/forms/forms-exam-form";

export default async function NewFormsExamPage() {
  await requireRole("lecturer", "admin");

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <Breadcrumbs
        items={[
          { label: "Dashboard", href: "/dashboard" },
          { label: "Google Forms quizzes", href: "/dashboard/lecturer/forms-exams" },
          { label: "New Forms quiz" },
        ]}
      />
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">New Google Forms quiz</h1>
        <p className="text-muted-foreground mt-2 max-w-2xl">
          Wrap an existing Google Form with proctoring. Saved as a draft first — publish it from
          the list once you&apos;re ready to share the student link.
        </p>
      </header>
      <FormsExamForm />
    </div>
  );
}
