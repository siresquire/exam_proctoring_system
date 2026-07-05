import { notFound } from "next/navigation";

import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { BankDetail } from "@/components/questions/bank-detail";
import type { BankQuestionRow, QuestionBankRow, QuestionCategoryRow } from "@/lib/supabase/types";

export default async function QuestionBankDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireRole("lecturer", "admin");
  const { id } = await params;

  const supabase = await createClient();
  if (!supabase) {
    notFound();
  }

  const { data: bank } = await supabase
    .from("question_banks")
    .select("*")
    .eq("id", id)
    .maybeSingle<QuestionBankRow>();
  if (!bank) {
    notFound();
  }

  const { data: categories } = await supabase
    .from("question_categories")
    .select("*")
    .eq("bank_id", id)
    .order("name");

  const { data: questions } = await supabase.rpc("bank_questions", { bank_id: id });

  return (
    <BankDetail
      bank={bank}
      categories={(categories ?? []) as QuestionCategoryRow[]}
      questions={(questions ?? []) as BankQuestionRow[]}
    />
  );
}
