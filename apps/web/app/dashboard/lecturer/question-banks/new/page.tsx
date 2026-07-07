import { requireRole } from "@/lib/auth";
import { Breadcrumbs } from "@/components/layout/breadcrumbs";
import { NewBankForm } from "@/components/questions/new-bank-form";

export default async function NewQuestionBankPage() {
  await requireRole("lecturer", "admin");

  return (
    <div className="mx-auto max-w-xl px-4 py-10 sm:px-6">
      <Breadcrumbs
        items={[
          { label: "Dashboard", href: "/dashboard" },
          { label: "Question banks", href: "/dashboard/lecturer/question-banks" },
          { label: "New bank" },
        ]}
      />
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">New question bank</h1>
        <p className="text-muted-foreground mt-2 max-w-2xl">
          Give the bank a name. You can add categories and author questions once it&apos;s created.
        </p>
      </header>
      <NewBankForm />
    </div>
  );
}
