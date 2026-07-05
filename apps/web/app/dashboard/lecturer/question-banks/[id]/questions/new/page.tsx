import { notFound } from "next/navigation";

import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { NewQuestionForm } from "@/components/questions/new-question-form";
import type { QuestionBankRow, QuestionCategoryRow } from "@/lib/supabase/types";

export default async function NewQuestionPage({ params }: { params: Promise<{ id: string }> }) {
  await requireRole("lecturer", "admin");
  const { id } = await params;

  const supabase = await createClient();
  if (!supabase) notFound();

  const { data: bank } = await supabase
    .from("question_banks")
    .select("*")
    .eq("id", id)
    .maybeSingle<QuestionBankRow>();
  if (!bank) notFound();

  const { data: categories } = await supabase
    .from("question_categories")
    .select("*")
    .eq("bank_id", id)
    .order("name");

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">New question — {bank.name}</h1>
        <p className="text-muted-foreground mt-2 max-w-2xl">
          Choose a type below; the fields change to match. Saving creates the question and its first
          version.
        </p>
      </header>
      <NewQuestionForm bankId={bank.id} categories={(categories ?? []) as QuestionCategoryRow[]} />
    </div>
  );
}
