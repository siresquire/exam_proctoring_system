"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, CloudOff, Flag, FlagOff, RefreshCw, Save } from "lucide-react";

import { AnswerInput, type AnswerResponse } from "@/components/exam-room/answer-input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ANNOUNCE_THRESHOLDS_MS,
  computeServerOffsetMs,
  formatClockTime,
  formatCountdown,
  remainingMs,
} from "@/lib/exam-room/timer";
import { notify } from "@/lib/notify";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import type { AttemptQuestion, AttemptQuestions, SubmitAttemptResult } from "@/lib/supabase/types";

const AUTOSAVE_DEBOUNCE_MS = 900;

interface FlatQuestion extends AttemptQuestion {
  sectionTitle: string;
  sectionIndex: number;
}

type SaveState = "idle" | "saving" | "saved" | "offline";

interface PendingSave {
  questionRef: string;
  response: AnswerResponse;
  flagged: boolean;
}

/**
 * Phase 3d-i exam room: one question at a time + palette (modeled on
 * proctor/sample-quiz.tsx), backed by the real attempt RPCs. Every answer
 * change autosaves (debounced) via save_exam_answer with a visible "Saved
 * HH:MM:SS" indicator; a failed save buffers locally and shows a calm
 * "reconnecting" state (DESIGN.md §2.6) rather than an alarming error; the
 * countdown is derived from the server's own clock (get_attempt_questions'
 * server_now), never the browser's, and announces at 30/15/5/1 minutes via
 * aria-live polite before auto-submitting at zero.
 */
export function ExamRoom({ initial, examTitle }: { initial: AttemptQuestions; examTitle: string }) {
  const [responses, setResponses] = useState<Record<string, AnswerResponse>>(() => {
    const map: Record<string, AnswerResponse> = {};
    for (const a of initial.answers) map[a.question_ref] = a.response as AnswerResponse;
    return map;
  });
  const [flagged, setFlagged] = useState<Set<string>>(
    () => new Set(initial.answers.filter((a) => a.flagged).map((a) => a.question_ref)),
  );
  const [current, setCurrent] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(true);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  // Placeholder until the mount effect below measures the real
  // server/client clock offset and computes the true remaining time — see
  // that effect for why this can't be computed here (Date.now() is impure
  // and React's purity rule disallows calling it during render, including
  // inside a lazy useState initializer).
  const deadlineMs = useMemo(() => new Date(initial.deadline_at).getTime(), [initial.deadline_at]);
  const [remaining, setRemaining] = useState(() => deadlineMs - new Date(initial.server_now).getTime());
  const [result, setResult] = useState<SubmitAttemptResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [timerAnnouncement, setTimerAnnouncement] = useState("");

  // Measured once on mount (see the effect below) rather than during
  // render — Date.now() is an impure call and React's purity rule flags it
  // if invoked directly in the render body, even just to seed a ref.
  const offsetMsRef = useRef(0);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<Map<string, PendingSave>>(new Map());
  const flushingRef = useRef(false);
  const announcedRef = useRef(new Set<number>());
  const autoSubmittedRef = useRef(false);

  const flat: FlatQuestion[] = useMemo(() => {
    const out: FlatQuestion[] = [];
    initial.sections.forEach((section, sectionIndex) => {
      section.questions.forEach((q) => {
        out.push({ ...q, sectionTitle: section.title, sectionIndex });
      });
    });
    return out;
  }, [initial.sections]);

  const total = flat.length;
  const question = flat[current];

  const answeredCount = useMemo(
    () => flat.filter((q) => {
      const r = responses[q.question_ref];
      return r !== null && r !== undefined;
    }).length,
    [flat, responses],
  );

  // --- autosave -------------------------------------------------------

  const flushPending = useCallback(async () => {
    if (flushingRef.current) return;
    const attemptId = initial.attempt_id;
    const supabase = createClient();
    if (!supabase) return;

    flushingRef.current = true;
    try {
      while (pendingRef.current.size > 0) {
        const [ref, pending] = pendingRef.current.entries().next().value as [string, PendingSave];
        pendingRef.current.delete(ref);
        setSaveState("saving");
        const { error } = await supabase.rpc("save_exam_answer", {
          attempt_id: attemptId,
          question_ref: pending.questionRef,
          response: pending.response as never,
          flagged: pending.flagged,
        });
        if (error) {
          // Buffer it back and stop — calm reconnect state, never a scary
          // error (DESIGN.md §2.6). The change is still held in `responses`
          // client-side, so nothing the student typed is lost.
          pendingRef.current.set(ref, pending);
          setSaveState("offline");
          flushingRef.current = false;
          return;
        }
      }
      setSaveState("saved");
      setLastSavedAt(new Date());
    } finally {
      flushingRef.current = false;
    }
  }, [initial.attempt_id]);

  const scheduleSave = useCallback(
    (questionRef: string, response: AnswerResponse, isFlagged: boolean) => {
      pendingRef.current.set(questionRef, { questionRef, response, flagged: isFlagged });
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        void flushPending();
      }, AUTOSAVE_DEBOUNCE_MS);
    },
    [flushPending],
  );

  // Retry a buffered save when the browser regains connectivity.
  useEffect(() => {
    function handleOnline() {
      if (pendingRef.current.size > 0) void flushPending();
    }
    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, [flushPending]);

  // Periodic retry while offline (covers "still connected but the request
  // failed" cases the online/offline events don't catch).
  useEffect(() => {
    if (saveState !== "offline") return;
    const id = setInterval(() => void flushPending(), 5000);
    return () => clearInterval(id);
  }, [saveState, flushPending]);

  function handleAnswerChange(response: AnswerResponse) {
    if (!question || result) return;
    setResponses((prev) => ({ ...prev, [question.question_ref]: response }));
    scheduleSave(question.question_ref, response, flagged.has(question.question_ref));
  }

  function toggleFlag() {
    if (!question || result) return;
    setFlagged((prev) => {
      const next = new Set(prev);
      const isFlagged = next.has(question.question_ref);
      if (isFlagged) next.delete(question.question_ref);
      else next.add(question.question_ref);
      scheduleSave(question.question_ref, responses[question.question_ref] ?? null, !isFlagged);
      return next;
    });
  }

  function goTo(index: number) {
    if (result) return;
    setCurrent(Math.max(0, Math.min(total - 1, index)));
  }

  // --- server-authoritative timer --------------------------------------

  const handleSubmit = useCallback(
    async (auto: boolean) => {
      if (result || submitting) return;
      const supabase = createClient();
      if (!supabase) return;

      if (!auto) {
        const unanswered = flat
          .map((q, i) => (responses[q.question_ref] ? null : i + 1))
          .filter((n): n is number => n !== null);

        if (unanswered.length > 0) {
          const confirmed = await notify.confirm({
            title: "Submit with unanswered questions?",
            text: `Question${unanswered.length > 1 ? "s" : ""} ${unanswered.join(", ")} ${
              unanswered.length > 1 ? "are" : "is"
            } unanswered. You can go back and finish, or submit anyway.`,
            confirmButtonText: "Submit anyway",
            cancelButtonText: "Go back and finish",
          });
          if (!confirmed) return;
        } else {
          const confirmed = await notify.confirm({
            title: "Submit exam?",
            text: "You will not be able to change your answers after this.",
            confirmButtonText: "Submit",
          });
          if (!confirmed) return;
        }
      }

      setSubmitting(true);
      // Flush any buffered autosave before submitting so a last-second
      // answer is never lost to a race with submit.
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      await flushPending();

      const { data, error } = await supabase.rpc("submit_exam_attempt", {
        attempt_id: initial.attempt_id,
      });
      setSubmitting(false);

      if (error || !data) {
        await notify.error("Could not submit", error?.message ?? "Unknown error");
        return;
      }

      setResult(data as SubmitAttemptResult);
      if (auto) {
        await notify.info("Time's up", "Your exam was submitted automatically.");
      } else {
        await notify.success("Exam submitted", "Your answers have been recorded.");
      }
    },
    [flat, flushPending, initial.attempt_id, responses, result, submitting],
  );

  // Measure the server/client clock offset exactly once, on mount — this is
  // the one place Date.now() is actually called, inside an effect (not
  // render), which is where React's purity rule permits impure reads.
  useEffect(() => {
    offsetMsRef.current = computeServerOffsetMs(initial.server_now, Date.now());
    setRemaining(remainingMs(initial.deadline_at, offsetMsRef.current));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount only; initial.* is a stable prop for this component's lifetime.
  }, []);

  useEffect(() => {
    if (result) return;
    const id = setInterval(() => {
      const ms = remainingMs(initial.deadline_at, offsetMsRef.current);
      setRemaining(ms);

      for (const threshold of ANNOUNCE_THRESHOLDS_MS) {
        if (ms <= threshold && ms > threshold - 1000 && !announcedRef.current.has(threshold)) {
          announcedRef.current.add(threshold);
          setTimerAnnouncement(`${formatCountdown(threshold)} remaining.`);
        }
      }

      if (ms <= 0 && !autoSubmittedRef.current) {
        autoSubmittedRef.current = true;
        void handleSubmit(true);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [initial.deadline_at, result, handleSubmit]);

  // --- submitted screen --------------------------------------------------

  if (result) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-xl">Exam submitted</CardTitle>
            <CardDescription>{examTitle}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {result.results_released ? (
              <div className="bg-secondary/40 rounded-md border p-4">
                <p className="text-sm font-medium">Your score</p>
                <p className="text-2xl font-semibold">
                  {result.auto_score} / {result.max_score}
                </p>
                {result.needs_manual_grading ? (
                  <p className="text-muted-foreground mt-1 text-sm">
                    Some questions require manual grading and are not yet included above.
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="text-muted-foreground text-sm">
                Your answers have been recorded. Results will be made available once your lecturer
                releases them.
              </p>
            )}
            <p className="text-muted-foreground text-sm">
              Status: <span className="font-medium">{result.status.replace("_", " ")}</span>
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!question) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6">
        <Card>
          <CardContent className="py-6 text-center text-sm">This exam has no questions.</CardContent>
        </Card>
      </div>
    );
  }

  const isFlagged = flagged.has(question.question_ref);
  const timeCritical = remaining <= 5 * 60_000;

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
      {/* aria-live region for the server-authoritative timer announcements
          (DESIGN.md §3 Robust: 30/15/5/1 min, polite). */}
      <p role="status" aria-live="polite" className="sr-only">
        {timerAnnouncement}
      </p>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">{examTitle}</h1>
          <p className="text-muted-foreground text-sm">
            {answeredCount} of {total} answered.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <SaveIndicator state={saveState} lastSavedAt={lastSavedAt} />
          <Badge
            variant={timeCritical ? "destructive" : "outline"}
            className="h-8 gap-1.5 px-3 font-mono text-sm"
          >
            {formatCountdown(remaining)}
          </Badge>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_auto]">
        <Card>
          <CardHeader className="flex-row items-start justify-between gap-4">
            <div>
              <CardTitle className="text-base">
                {question.sectionTitle} — Question {current + 1} of {total}
              </CardTitle>
            </div>
            <Button
              type="button"
              variant={isFlagged ? "secondary" : "outline"}
              size="sm"
              onClick={toggleFlag}
              aria-pressed={isFlagged}
            >
              {isFlagged ? <Flag aria-hidden="true" /> : <FlagOff aria-hidden="true" />}
              {isFlagged ? "Flagged for review" : "Flag for review"}
            </Button>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <p className="mb-3 font-medium">{question.prompt}</p>
              <AnswerInput
                question={question}
                response={responses[question.question_ref] ?? null}
                onChange={handleAnswerChange}
              />
            </div>

            <div className="flex items-center justify-between gap-2 border-t pt-4">
              <Button type="button" variant="outline" onClick={() => goTo(current - 1)} disabled={current === 0}>
                <ChevronLeft aria-hidden="true" />
                Previous
              </Button>
              <Button
                type="button"
                variant="outline"
                className="lg:hidden"
                onClick={() => setPaletteOpen((prev) => !prev)}
                aria-expanded={paletteOpen}
                aria-controls="attempt-question-palette"
              >
                Questions
              </Button>
              {current < total - 1 ? (
                <Button type="button" onClick={() => goTo(current + 1)}>
                  Next
                  <ChevronRight aria-hidden="true" />
                </Button>
              ) : (
                <Button type="button" onClick={() => void handleSubmit(false)} disabled={submitting}>
                  {submitting ? "Submitting…" : "Submit exam"}
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        <Card id="attempt-question-palette" className={cn("w-full lg:w-56", !paletteOpen && "hidden lg:block")}>
          <CardHeader>
            <CardTitle className="text-sm">Question palette</CardTitle>
            <CardDescription className="text-xs">Answered, flagged, and unseen at a glance.</CardDescription>
          </CardHeader>
          <CardContent>
            <div role="group" aria-label="Jump to question" className="grid grid-cols-5 gap-2 lg:grid-cols-3">
              {flat.map((q, index) => {
                const isAnswered = responses[q.question_ref] !== undefined && responses[q.question_ref] !== null;
                const isQFlagged = flagged.has(q.question_ref);
                const isCurrent = index === current;
                return (
                  <button
                    key={q.question_ref}
                    type="button"
                    onClick={() => goTo(index)}
                    aria-current={isCurrent ? "true" : undefined}
                    aria-label={`Question ${index + 1}${isAnswered ? ", answered" : ", not answered"}${
                      isQFlagged ? ", flagged for review" : ""
                    }`}
                    className={cn(
                      "relative flex size-10 min-h-11 min-w-11 items-center justify-center overflow-hidden rounded-md border text-sm font-medium",
                      isCurrent && "ring-ring ring-2 ring-offset-1",
                      isQFlagged
                        ? "border-accent bg-accent/15"
                        : isAnswered
                          ? "border-primary bg-primary/10"
                          : "border-border",
                    )}
                  >
                    {isQFlagged ? (
                      <span
                        aria-hidden="true"
                        className="bg-accent absolute right-0 top-0 size-3.5 [clip-path:polygon(100%_0,100%_100%,0_0)]"
                      />
                    ) : null}
                    <span className="flex flex-col items-center leading-none">
                      {index + 1}
                      {isQFlagged ? <Flag aria-hidden="true" className="text-accent-foreground mt-0.5 size-2.5" /> : null}
                    </span>
                  </button>
                );
              })}
            </div>
            <ul className="text-muted-foreground mt-4 space-y-1 text-xs">
              <li className="flex items-center gap-2">
                <span className="border-primary bg-primary/10 size-3 rounded border" aria-hidden="true" /> Answered
              </li>
              <li className="flex items-center gap-2">
                <span className="border-border size-3 rounded border" aria-hidden="true" /> Not answered
              </li>
              <li className="flex items-center gap-2">
                <span className="border-accent bg-accent/15 relative size-3 overflow-hidden rounded border" aria-hidden="true">
                  <span className="bg-accent absolute right-0 top-0 size-1.5 [clip-path:polygon(100%_0,100%_100%,0_0)]" />
                </span>
                <Flag aria-hidden="true" className="size-3" /> Flagged for review
              </li>
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function SaveIndicator({ state, lastSavedAt }: { state: SaveState; lastSavedAt: Date | null }) {
  if (state === "offline") {
    return (
      <p role="status" aria-live="polite" className="text-muted-foreground flex items-center gap-1.5 text-xs">
        <CloudOff aria-hidden="true" className="size-3.5" />
        Reconnecting… your answers are saved on this device.
      </p>
    );
  }
  if (state === "saving") {
    return (
      <p role="status" aria-live="polite" className="text-muted-foreground flex items-center gap-1.5 text-xs">
        <RefreshCw aria-hidden="true" className="size-3.5 animate-spin motion-reduce:animate-none" />
        Saving…
      </p>
    );
  }
  if (state === "saved" && lastSavedAt) {
    return (
      <p role="status" aria-live="polite" className="text-muted-foreground flex items-center gap-1.5 text-xs">
        <Save aria-hidden="true" className="size-3.5" />
        Saved {formatClockTime(lastSavedAt)}
      </p>
    );
  }
  return (
    <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
      <Save aria-hidden="true" className="size-3.5" />
      Not yet saved
    </p>
  );
}
