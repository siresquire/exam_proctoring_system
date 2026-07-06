"use client";

import { useState } from "react";

import { ExamAttemptIntro, type ExamAttemptIntroResult } from "@/components/exam-room/exam-attempt-intro";
import { ExamRoom } from "@/components/exam-room/exam-room";
import { notify } from "@/lib/notify";
import { createClient } from "@/lib/supabase/client";
import type { AttemptQuestions, ExamRow } from "@/lib/supabase/types";

type Phase = "intro" | "loading" | "room";

interface ExamAttemptWrapperProps {
  exam: ExamRow;
  studentNumber: string | null;
  fullName: string | null;
}

/**
 * Phase 3d-i entry point: intro/attestation -> start_exam_attempt (resumes
 * if already in progress) -> get_attempt_questions -> the exam room. Kept
 * as a thin phase machine so ExamRoom itself only ever deals with an
 * already-loaded, already-sanitized paper.
 */
export function ExamAttemptWrapper({ exam, studentNumber, fullName }: ExamAttemptWrapperProps) {
  const [phase, setPhase] = useState<Phase>("intro");
  const [initial, setInitial] = useState<AttemptQuestions | null>(null);

  async function handleStart(result: ExamAttemptIntroResult) {
    const supabase = createClient();
    if (!supabase) {
      await notify.error("Not configured", "Supabase is not configured in this environment.");
      return;
    }

    setPhase("loading");

    const { data: attemptId, error: startError } = await supabase.rpc("start_exam_attempt", {
      exam_id: exam.id,
      claimed_index_number: result.claimedIndexNumber,
      attested: result.attested,
    });

    if (startError || !attemptId) {
      await notify.error("Could not start exam", startError?.message ?? "Unknown error");
      setPhase("intro");
      return;
    }

    const { data: questions, error: questionsError } = await supabase.rpc("get_attempt_questions", {
      attempt_id: attemptId,
    });

    if (questionsError || !questions) {
      await notify.error("Could not load your exam", questionsError?.message ?? "Unknown error");
      setPhase("intro");
      return;
    }

    setInitial(questions as AttemptQuestions);
    setPhase("room");
  }

  if (phase === "room" && initial) {
    return <ExamRoom initial={initial} examTitle={exam.title} />;
  }

  if (phase === "loading") {
    return (
      <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6">
        <p role="status" aria-live="polite" className="text-muted-foreground text-center text-sm">
          Loading your exam…
        </p>
      </div>
    );
  }

  return (
    <ExamAttemptIntro exam={exam} studentNumber={studentNumber} fullName={fullName} onStart={handleStart} />
  );
}
