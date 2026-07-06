"use client";

import { useState } from "react";
import type { WebcamHandle } from "@proctor/core";

import { ExamAttemptIntro, type ExamAttemptIntroResult } from "@/components/exam-room/exam-attempt-intro";
import { ExamRoom } from "@/components/exam-room/exam-room";
import { ProctoredExamRoom } from "@/components/exam-room/proctored-exam-room";
import { ConsentScreen } from "@/components/proctor/consent-screen";
import { IdentityCheck, type IdentityCheckResult } from "@/components/proctor/identity-check";
import { notify } from "@/lib/notify";
import { createMediaPipeFaceDetectorAdapter } from "@/lib/proctor/face-detector";
import { createClient } from "@/lib/supabase/client";
import type { AttemptQuestions, ExamRow } from "@/lib/supabase/types";

type Phase = "intro" | "consent" | "identity" | "loading" | "room";

interface ExamAttemptWrapperProps {
  exam: ExamRow;
  studentNumber: string | null;
  fullName: string | null;
}

/**
 * Phase 3d-ii entry point, branched on the exam's integrity_tier — SERVER-
 * OWNED (loaded from the `exam` row itself, never chosen by this
 * component): the client cannot elevate or downgrade what proctoring runs.
 *
 * Tier 1: unchanged 3d-i flow — intro/attestation -> start_exam_attempt ->
 * get_attempt_questions -> the plain ExamRoom. No camera, server-side-only
 * anti-cheat.
 *
 * Tier 2+: consent -> identity verification (index number + portrait +
 * attestation, reusing the same components the Phase 2a Forms wrapper and
 * the Phase 1.x demo use) -> start_exam_attempt (which, for tier>=2, ALSO
 * starts a linked proctor session server-side using the exam's own
 * tier/policy — see the 20260705000013 migration) -> get_attempt_questions
 * (now also returns proctor_session_id) -> ProctoredExamRoom, which wraps
 * the same ExamRoom with the live proctor-core engine + monitoring panel.
 */
export function ExamAttemptWrapper({ exam, studentNumber, fullName }: ExamAttemptWrapperProps) {
  const isProctored = exam.integrity_tier >= 2;
  const [phase, setPhase] = useState<Phase>(isProctored ? "consent" : "intro");
  const [initial, setInitial] = useState<AttemptQuestions | null>(null);
  const [faceDetector] = useState(() => (isProctored ? createMediaPipeFaceDetectorAdapter() : undefined));
  const [webcamHandle, setWebcamHandle] = useState<WebcamHandle | null>(null);

  async function startAttemptAndLoad(claimedIndexNumber: string, attested: boolean) {
    const supabase = createClient();
    if (!supabase) {
      await notify.error("Not configured", "Supabase is not configured in this environment.");
      return false;
    }

    setPhase("loading");

    const { data: attemptId, error: startError } = await supabase.rpc("start_exam_attempt", {
      exam_id: exam.id,
      claimed_index_number: claimedIndexNumber,
      attested,
    });

    if (startError || !attemptId) {
      await notify.error("Could not start exam", startError?.message ?? "Unknown error");
      setPhase(isProctored ? "consent" : "intro");
      return false;
    }

    const { data: questions, error: questionsError } = await supabase.rpc("get_attempt_questions", {
      attempt_id: attemptId,
    });

    if (questionsError || !questions) {
      await notify.error("Could not load your exam", questionsError?.message ?? "Unknown error");
      setPhase(isProctored ? "consent" : "intro");
      return false;
    }

    setInitial(questions as AttemptQuestions);
    setPhase("room");
    return true;
  }

  // --- Tier 1: unchanged 3d-i flow ---------------------------------------

  async function handleUnproctoredStart(result: ExamAttemptIntroResult) {
    await startAttemptAndLoad(result.claimedIndexNumber, result.attested);
  }

  // --- Tier 2+: consent -> identity -> start (+ linked proctor session) --

  function handleConsent() {
    setPhase("identity");
  }

  async function handleIdentityVerified(result: IdentityCheckResult) {
    setWebcamHandle(result.webcamHandle);
    const ok = await startAttemptAndLoad(result.claimedIndexNumber, result.attested);
    if (!ok) {
      // start_exam_attempt failed downstream — reclaim the camera rather
      // than leaking an open stream nobody will ever stop.
      result.webcamHandle.stop();
      setWebcamHandle(null);
    }
  }

  if (phase === "room" && initial) {
    if (isProctored && initial.proctor_session_id) {
      const tier = (exam.integrity_tier >= 4 ? 4 : exam.integrity_tier >= 3 ? 3 : 2) as 2 | 3 | 4;
      return (
        <ProctoredExamRoom
          initial={initial}
          examTitle={exam.title}
          proctorSessionId={initial.proctor_session_id}
          integrityTier={tier}
          webcamHandle={webcamHandle}
        />
      );
    }
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

  if (isProctored) {
    if (phase === "identity") {
      return (
        <div className="px-4 py-10 sm:px-6">
          <IdentityCheck fullName={fullName} onVerified={handleIdentityVerified} faceDetector={faceDetector} />
        </div>
      );
    }
    // "consent" (default entry phase for a proctored exam)
    return (
      <div className="px-4 py-10 sm:px-6">
        <ConsentScreen onConsent={handleConsent} />
      </div>
    );
  }

  return (
    <ExamAttemptIntro
      exam={exam}
      studentNumber={studentNumber}
      fullName={fullName}
      onStart={handleUnproctoredStart}
    />
  );
}
