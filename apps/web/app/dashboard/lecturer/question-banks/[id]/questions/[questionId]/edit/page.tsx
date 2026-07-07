import { notFound } from "next/navigation";

import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Breadcrumbs } from "@/components/layout/breadcrumbs";
import { EditQuestionForm } from "@/components/questions/edit-question-form";
import type { BankQuestionRow, QuestionBankRow } from "@/lib/supabase/types";

export default async function EditQuestionPage({
  params,
}: {
  params: Promise<{ id: string; questionId: string }>;
}) {
  await requireRole("lecturer", "admin");
  const { id, questionId } = await params;

  const supabase = await createClient();
  if (!supabase) notFound();

  const { data: bank } = await supabase
    .from("question_banks")
    .select("*")
    .eq("id", id)
    .maybeSingle<QuestionBankRow>();
  if (!bank) notFound();

  const { data: questions } = await supabase.rpc("bank_questions", { bank_id: id });
  const question = ((questions ?? []) as BankQuestionRow[]).find((q) => q.question_id === questionId);
  if (!question) notFound();

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <Breadcrumbs
        items={[
          { label: "Dashboard", href: "/dashboard" },
          { label: "Question banks", href: "/dashboard/lecturer/question-banks" },
          { label: bank.name, href: `/dashboard/lecturer/question-banks/${bank.id}` },
          { label: "Edit question" },
        ]}
      />
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Edit question — {bank.name}</h1>
        <p className="text-muted-foreground mt-2 max-w-2xl">
          Currently version {question.version_no}. Saving creates version {(question.version_no ?? 1) + 1} —
          the old version is kept for any past exam attempts that already used it.
        </p>
      </header>
      <EditQuestionForm bankId={bank.id} question={question} />
    </div>
  );
}
