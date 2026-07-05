import { notFound } from "next/navigation";

import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { QuestionImportForm } from "@/components/questions/question-import-form";
import type { QuestionBankRow } from "@/lib/supabase/types";

export default async function ImportQuestionsPage({ params }: { params: Promise<{ id: string }> }) {
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

  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Bulk import — {bank.name}</h1>
        <p className="text-muted-foreground mt-2 max-w-2xl">
          Paste or upload CSV, Aiken, or GIFT content. Nothing is created until you review the preview
          and confirm.
        </p>
      </header>
      <QuestionImportForm bankId={bank.id} />
    </div>
  );
}
