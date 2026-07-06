"use server";

import { revalidatePath } from "next/cache";

import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type {
  ExamDraw,
  ExamResultRow,
  ExamResultsRelease,
  ExamSectionSourceType,
  ExamValidationResult,
  Json,
  QuestionDifficultyDb,
} from "@/lib/supabase/types";

const EXAMS_PATH = "/dashboard/lecturer/exams";

export interface ActionResult {
  error?: string;
  id?: string;
}

export async function createExam(title: string, description: string, classId: string | null): Promise<ActionResult> {
  await requireRole("lecturer", "admin");

  const trimmedTitle = title.trim();
  if (!trimmedTitle) {
    return { error: "Exam title is required." };
  }

  const supabase = await createClient();
  if (!supabase) {
    return { error: "Supabase is not configured in this environment." };
  }

  const { data, error } = await supabase.rpc("create_exam", {
    title: trimmedTitle,
    description: description.trim() || null,
    class_id: classId,
  });

  if (error || !data) {
    return { error: error?.message ?? "Could not create the exam." };
  }

  revalidatePath(EXAMS_PATH);
  return { id: data };
}

export interface UpdateExamInput {
  examId: string;
  title: string;
  description: string;
  classId: string | null;
  opensAt: string | null;
  closesAt: string | null;
  durationMinutes: number | null;
  integrityTier: number;
  violationPolicy: Record<string, { severity: string; counts: boolean }>;
  shuffleQuestions: boolean;
  shuffleOptions: boolean;
  resultsRelease: ExamResultsRelease;
}

export async function updateExam(input: UpdateExamInput): Promise<ActionResult> {
  await requireRole("lecturer", "admin");

  const trimmedTitle = input.title.trim();
  if (!trimmedTitle) {
    return { error: "Exam title is required." };
  }

  const supabase = await createClient();
  if (!supabase) {
    return { error: "Supabase is not configured in this environment." };
  }

  const { error } = await supabase.rpc("update_exam", {
    exam_id: input.examId,
    title: trimmedTitle,
    description: input.description.trim() || null,
    class_id: input.classId,
    opens_at: input.opensAt,
    closes_at: input.closesAt,
    duration_minutes: input.durationMinutes,
    integrity_tier: input.integrityTier,
    violation_policy: input.violationPolicy as unknown as Json,
    shuffle_questions: input.shuffleQuestions,
    shuffle_options: input.shuffleOptions,
    results_release: input.resultsRelease,
  });

  if (error) {
    return { error: error.message };
  }

  revalidatePath(`${EXAMS_PATH}/${input.examId}`);
  return { id: input.examId };
}

export async function addExamSection(examId: string, title: string, description: string): Promise<ActionResult> {
  await requireRole("lecturer", "admin");

  const trimmedTitle = title.trim();
  if (!trimmedTitle) {
    return { error: "Section title is required." };
  }

  const supabase = await createClient();
  if (!supabase) {
    return { error: "Supabase is not configured in this environment." };
  }

  const { data, error } = await supabase.rpc("add_exam_section", {
    exam_id: examId,
    title: trimmedTitle,
    description: description.trim() || null,
  });

  if (error || !data) {
    return { error: error?.message ?? "Could not add the section." };
  }

  revalidatePath(`${EXAMS_PATH}/${examId}`);
  return { id: data };
}

export async function reorderExamSection(examId: string, sectionId: string, direction: "up" | "down"): Promise<ActionResult> {
  await requireRole("lecturer", "admin");

  const supabase = await createClient();
  if (!supabase) {
    return { error: "Supabase is not configured in this environment." };
  }

  const { error } = await supabase.rpc("reorder_exam_section", { section_id: sectionId, direction });
  if (error) {
    return { error: error.message };
  }

  revalidatePath(`${EXAMS_PATH}/${examId}`);
  return {};
}

export async function removeExamSection(examId: string, sectionId: string): Promise<ActionResult> {
  await requireRole("lecturer", "admin");

  const supabase = await createClient();
  if (!supabase) {
    return { error: "Supabase is not configured in this environment." };
  }

  const { error } = await supabase.rpc("remove_exam_section", { section_id: sectionId });
  if (error) {
    return { error: error.message };
  }

  revalidatePath(`${EXAMS_PATH}/${examId}`);
  return {};
}

export interface AddSourceInput {
  examId: string;
  sectionId: string;
  sourceType: ExamSectionSourceType;
  questionId?: string | null;
  bankId?: string | null;
  categoryId?: string | null;
  difficulty?: QuestionDifficultyDb | null;
  tags?: string[] | null;
  drawCount?: number | null;
}

export async function addSectionSource(input: AddSourceInput): Promise<ActionResult> {
  await requireRole("lecturer", "admin");

  const supabase = await createClient();
  if (!supabase) {
    return { error: "Supabase is not configured in this environment." };
  }

  const { data, error } = await supabase.rpc("add_section_source", {
    section_id: input.sectionId,
    source_type: input.sourceType,
    question_id: input.questionId ?? null,
    bank_id: input.bankId ?? null,
    category_id: input.categoryId ?? null,
    difficulty: input.difficulty ?? null,
    tags: input.tags ?? null,
    draw_count: input.drawCount ?? null,
  });

  if (error || !data) {
    return { error: error?.message ?? "Could not add the source." };
  }

  revalidatePath(`${EXAMS_PATH}/${input.examId}`);
  return { id: data };
}

export async function removeSectionSource(examId: string, sourceId: string): Promise<ActionResult> {
  await requireRole("lecturer", "admin");

  const supabase = await createClient();
  if (!supabase) {
    return { error: "Supabase is not configured in this environment." };
  }

  const { error } = await supabase.rpc("remove_section_source", { source_id: sourceId });
  if (error) {
    return { error: error.message };
  }

  revalidatePath(`${EXAMS_PATH}/${examId}`);
  return {};
}

export interface ValidateExamResult {
  error?: string;
  result?: ExamValidationResult;
}

export async function validateExam(examId: string): Promise<ValidateExamResult> {
  await requireRole("lecturer", "admin");

  const supabase = await createClient();
  if (!supabase) {
    return { error: "Supabase is not configured in this environment." };
  }

  const { data, error } = await supabase.rpc("validate_exam", { exam_id: examId });
  if (error) {
    return { error: error.message };
  }

  return { result: data as unknown as ExamValidationResult };
}

export async function setExamStatus(examId: string, status: "draft" | "published" | "closed"): Promise<ActionResult> {
  await requireRole("lecturer", "admin");

  const supabase = await createClient();
  if (!supabase) {
    return { error: "Supabase is not configured in this environment." };
  }

  const { error } = await supabase.rpc("set_exam_status", { exam_id: examId, status });
  if (error) {
    return { error: error.message };
  }

  revalidatePath(EXAMS_PATH);
  revalidatePath(`${EXAMS_PATH}/${examId}`);
  return { id: examId };
}

export interface PreviewDrawResult {
  error?: string;
  draw?: ExamDraw;
}

export async function previewExamDraw(examId: string): Promise<PreviewDrawResult> {
  await requireRole("lecturer", "admin");

  const supabase = await createClient();
  if (!supabase) {
    return { error: "Supabase is not configured in this environment." };
  }

  const { data, error } = await supabase.rpc("preview_exam_draw", { exam_id: examId });
  if (error) {
    return { error: error.message };
  }

  return { draw: data as unknown as ExamDraw };
}

export interface PoolCountResult {
  error?: string;
  count?: number;
}

export async function fetchPoolAvailableCount(
  bankId: string,
  categoryId: string | null,
  difficulty: string | null,
  tags: string[] | null,
): Promise<PoolCountResult> {
  await requireRole("lecturer", "admin");

  const supabase = await createClient();
  if (!supabase) {
    return { error: "Supabase is not configured in this environment." };
  }

  const { data, error } = await supabase.rpc("pool_available_count", {
    bank_id: bankId,
    category_id: categoryId,
    difficulty,
    tags,
  });

  if (error) {
    return { error: error.message };
  }

  return { count: data as unknown as number };
}

// --- Phase 3d-ii: grading + results release --------------------------------

export interface ExamResultsResult {
  error?: string;
  rows?: ExamResultRow[];
}

export async function fetchExamResults(examId: string): Promise<ExamResultsResult> {
  await requireRole("lecturer", "admin");

  const supabase = await createClient();
  if (!supabase) {
    return { error: "Supabase is not configured in this environment." };
  }

  const { data, error } = await supabase.rpc("exam_results", { exam_id: examId });
  if (error) {
    return { error: error.message };
  }

  return { rows: (data ?? []) as ExamResultRow[] };
}

export async function gradeEssaySlot(
  attemptId: string,
  questionRef: string,
  marksAwarded: number,
  feedback: string,
): Promise<ActionResult> {
  await requireRole("lecturer", "admin");

  const supabase = await createClient();
  if (!supabase) {
    return { error: "Supabase is not configured in this environment." };
  }

  const { error } = await supabase.rpc("grade_essay_slot", {
    attempt_id: attemptId,
    question_ref: questionRef,
    marks_awarded: marksAwarded,
    feedback: feedback.trim() || null,
  });

  if (error) {
    return { error: error.message };
  }

  revalidatePath(`${EXAMS_PATH}/${attemptId}/grade`);
  return {};
}

export async function finalizeAttemptGrade(attemptId: string): Promise<ActionResult> {
  await requireRole("lecturer", "admin");

  const supabase = await createClient();
  if (!supabase) {
    return { error: "Supabase is not configured in this environment." };
  }

  const { error } = await supabase.rpc("finalize_attempt_grade", { attempt_id: attemptId });
  if (error) {
    return { error: error.message };
  }

  return {};
}

export async function releaseExamResults(examId: string): Promise<ActionResult> {
  await requireRole("lecturer", "admin");

  const supabase = await createClient();
  if (!supabase) {
    return { error: "Supabase is not configured in this environment." };
  }

  const { error } = await supabase.rpc("release_exam_results", { exam_id: examId });
  if (error) {
    return { error: error.message };
  }

  revalidatePath(`${EXAMS_PATH}/${examId}/results`);
  return { id: examId };
}
