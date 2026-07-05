"use server";

import { revalidatePath } from "next/cache";

import { requireRole } from "@/lib/auth";
import { bodyToWireShape } from "@/lib/questions/types";
import type { QuestionBody, QuestionDifficulty, QuestionType } from "@/lib/questions/types";
import { createClient } from "@/lib/supabase/server";
import type { BankQuestionRow, Json } from "@/lib/supabase/types";

const BANKS_PATH = "/dashboard/lecturer/question-banks";

export interface ActionResult {
  error?: string;
  id?: string;
}

export async function createQuestionBank(name: string, description: string): Promise<ActionResult> {
  await requireRole("lecturer", "admin");

  const trimmedName = name.trim();
  if (!trimmedName) {
    return { error: "Bank name is required." };
  }

  const supabase = await createClient();
  if (!supabase) {
    return { error: "Supabase is not configured in this environment." };
  }

  const { data, error } = await supabase.rpc("create_question_bank", {
    name: trimmedName,
    description: description.trim() || null,
  });

  if (error || !data) {
    return { error: error?.message ?? "Could not create the bank." };
  }

  revalidatePath(BANKS_PATH);
  return { id: data };
}

// --- categories --------------------------------------------------------------

export async function createCategory(
  bankId: string,
  name: string,
  parentId: string | null,
): Promise<ActionResult> {
  await requireRole("lecturer", "admin");

  const trimmedName = name.trim();
  if (!trimmedName) {
    return { error: "Category name is required." };
  }

  const supabase = await createClient();
  if (!supabase) {
    return { error: "Supabase is not configured in this environment." };
  }

  const { data, error } = await supabase.rpc("create_question_category", {
    bank_id: bankId,
    name: trimmedName,
    parent_id: parentId,
  });

  if (error || !data) {
    return { error: error?.message ?? "Could not create the category." };
  }

  revalidatePath(`${BANKS_PATH}/${bankId}`);
  return { id: data };
}

export async function renameCategory(bankId: string, categoryId: string, name: string): Promise<ActionResult> {
  await requireRole("lecturer", "admin");

  const trimmedName = name.trim();
  if (!trimmedName) {
    return { error: "Category name is required." };
  }

  const supabase = await createClient();
  if (!supabase) {
    return { error: "Supabase is not configured in this environment." };
  }

  const { error } = await supabase.rpc("rename_question_category", { category_id: categoryId, name: trimmedName });
  if (error) {
    return { error: error.message };
  }

  revalidatePath(`${BANKS_PATH}/${bankId}`);
  return {};
}

export async function deleteCategory(bankId: string, categoryId: string): Promise<ActionResult> {
  await requireRole("lecturer", "admin");

  const supabase = await createClient();
  if (!supabase) {
    return { error: "Supabase is not configured in this environment." };
  }

  const { error } = await supabase.rpc("delete_question_category", { category_id: categoryId });
  if (error) {
    return { error: error.message };
  }

  revalidatePath(`${BANKS_PATH}/${bankId}`);
  return {};
}

// --- questions -----------------------------------------------------------------

export interface QuestionInput {
  bankId: string;
  type: QuestionType;
  categoryId: string | null;
  difficulty: QuestionDifficulty;
  tags: string[];
  prompt: string;
  body: QuestionBody;
}

export async function createQuestion(input: QuestionInput): Promise<ActionResult> {
  await requireRole("lecturer", "admin");

  const trimmedPrompt = input.prompt.trim();
  if (!trimmedPrompt) {
    return { error: "Question prompt is required." };
  }

  const supabase = await createClient();
  if (!supabase) {
    return { error: "Supabase is not configured in this environment." };
  }

  const { data, error } = await supabase.rpc("create_question", {
    bank_id: input.bankId,
    type: input.type,
    category_id: input.categoryId,
    difficulty: input.difficulty,
    tags: input.tags,
    prompt: trimmedPrompt,
    body: bodyToWireShape(input.body) as Json,
  });

  if (error || !data) {
    return { error: error?.message ?? "Could not create the question." };
  }

  revalidatePath(`${BANKS_PATH}/${input.bankId}`);
  return { id: data };
}

export interface EditQuestionInput {
  bankId: string;
  questionId: string;
  prompt: string;
  body: QuestionBody;
}

export async function addQuestionVersion(input: EditQuestionInput): Promise<ActionResult> {
  await requireRole("lecturer", "admin");

  const trimmedPrompt = input.prompt.trim();
  if (!trimmedPrompt) {
    return { error: "Question prompt is required." };
  }

  const supabase = await createClient();
  if (!supabase) {
    return { error: "Supabase is not configured in this environment." };
  }

  const { data, error } = await supabase.rpc("add_question_version", {
    question_id: input.questionId,
    prompt: trimmedPrompt,
    body: bodyToWireShape(input.body) as Json,
  });

  if (error || !data) {
    return { error: error?.message ?? "Could not save the new version." };
  }

  revalidatePath(`${BANKS_PATH}/${input.bankId}`);
  return { id: data };
}

export async function setQuestionStatus(
  bankId: string,
  questionId: string,
  status: "active" | "retired",
): Promise<ActionResult> {
  await requireRole("lecturer", "admin");

  const supabase = await createClient();
  if (!supabase) {
    return { error: "Supabase is not configured in this environment." };
  }

  const { error } = await supabase.rpc("set_question_status", { question_id: questionId, status });
  if (error) {
    return { error: error.message };
  }

  revalidatePath(`${BANKS_PATH}/${bankId}`);
  return {};
}

export interface BankQuestionsResult {
  error?: string;
  rows?: BankQuestionRow[];
}

export async function fetchBankQuestions(bankId: string): Promise<BankQuestionsResult> {
  await requireRole("lecturer", "admin");

  const supabase = await createClient();
  if (!supabase) {
    return { error: "Supabase is not configured in this environment." };
  }

  const { data, error } = await supabase.rpc("bank_questions", { bank_id: bankId });
  if (error) {
    return { error: error.message };
  }

  return { rows: (data ?? []) as BankQuestionRow[] };
}
