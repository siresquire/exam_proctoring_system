import { notFound } from "next/navigation";

import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { ExamBuilder } from "@/components/exams/exam-builder";
import type {
  BankQuestionRow,
  ClassRow,
  ExamRow,
  ExamSectionRow,
  ExamSectionSourceRow,
  QuestionBankRow,
  QuestionCategoryRow,
} from "@/lib/supabase/types";

export default async function ExamDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireRole("lecturer", "admin");
  const { id } = await params;

  const supabase = await createClient();
  if (!supabase) {
    notFound();
  }

  const { data: exam } = await supabase.from("exams").select("*").eq("id", id).maybeSingle<ExamRow>();
  if (!exam) {
    notFound();
  }

  const [{ data: sections }, { data: classes }, { data: banks }] = await Promise.all([
    supabase.from("exam_sections").select("*").eq("exam_id", id).order("ordinal"),
    supabase.from("classes").select("*").order("name"),
    supabase.from("question_banks").select("*").order("name"),
  ]);

  const sectionIds = (sections ?? []).map((s) => s.id);
  let sources: ExamSectionSourceRow[] = [];
  if (sectionIds.length > 0) {
    const { data } = await supabase
      .from("exam_section_sources")
      .select("*")
      .in("section_id", sectionIds)
      .order("ordinal");
    sources = data ?? [];
  }

  // Preload every bank's question list + categories so the "pick specific
  // questions" / "draw N from pool" pickers don't need a round trip per
  // bank selection. Banks are typically few (a lecturer's own authoring
  // scope), so this is cheap.
  const bankRows = (banks ?? []) as QuestionBankRow[];
  const questionsByBank: Record<string, BankQuestionRow[]> = {};
  const categoriesByBank: Record<string, QuestionCategoryRow[]> = {};
  await Promise.all(
    bankRows.map(async (bank) => {
      const [{ data: qs }, { data: cats }] = await Promise.all([
        supabase.rpc("bank_questions", { bank_id: bank.id }),
        supabase.from("question_categories").select("*").eq("bank_id", bank.id).order("name"),
      ]);
      questionsByBank[bank.id] = (qs ?? []) as BankQuestionRow[];
      categoriesByBank[bank.id] = (cats ?? []) as QuestionCategoryRow[];
    }),
  );

  return (
    <ExamBuilder
      exam={exam}
      sections={(sections ?? []) as ExamSectionRow[]}
      sources={sources}
      classes={(classes ?? []) as ClassRow[]}
      banks={bankRows}
      questionsByBank={questionsByBank}
      categoriesByBank={categoriesByBank}
    />
  );
}
