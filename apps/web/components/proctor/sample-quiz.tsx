"use client";

import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Flag, FlagOff } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { notify } from "@/lib/notify";
import { cn } from "@/lib/utils";

export interface QuizQuestion {
  id: string;
  prompt: string;
  options: string[];
}

/**
 * Hardcoded, client-side only (real exam engine is Phase 3 — see PLAN.md).
 * Exists purely so Phase 1.5's violation demo happens inside a realistic
 * test-taking flow instead of a bare "session live" screen.
 */
export const SAMPLE_QUIZ_QUESTIONS: QuizQuestion[] = [
  {
    id: "q1",
    prompt: "Which layer of the OSI model is responsible for routing packets between networks?",
    options: ["Data Link", "Network", "Transport", "Session"],
  },
  {
    id: "q2",
    prompt: "In relational databases, which normal form eliminates transitive dependencies?",
    options: ["1NF", "2NF", "3NF", "BCNF"],
  },
  {
    id: "q3",
    prompt: "What is the time complexity of binary search on a sorted array of n elements?",
    options: ["O(n)", "O(log n)", "O(n log n)", "O(1)"],
  },
  {
    id: "q4",
    prompt:
      "Which Ghanaian data protection law governs the collection of personal data for this exam?",
    options: ["Act 843 (Data Protection Act)", "Act 792", "Act 963", "Act 1061"],
  },
  {
    id: "q5",
    prompt: "In software testing, what does the acronym 'UAT' stand for?",
    options: [
      "Unit Acceptance Testing",
      "User Acceptance Testing",
      "Universal Application Test",
      "Usability Assessment Trial",
    ],
  },
];

interface SampleQuizProps {
  disabled?: boolean;
  onSubmit: (answers: Record<string, number | undefined>) => void;
}

/**
 * One-question-at-a-time MCQ quiz with a question palette (recognition over
 * recall, DESIGN.md §2.4), flag-for-review, and an unanswered-question
 * confirmation on submit — all through notify.* (lib/notify.ts is the only
 * sanctioned popup gateway). `disabled` locks every control in place when
 * the proctoring session is terminated (Phase 1.5 violation limit).
 */
export function SampleQuiz({ disabled = false, onSubmit }: SampleQuizProps) {
  const [current, setCurrent] = useState(0);
  const [answers, setAnswers] = useState<Record<string, number | undefined>>({});
  const [flagged, setFlagged] = useState<Set<string>>(new Set());
  const [paletteOpen, setPaletteOpen] = useState(true);

  const question = SAMPLE_QUIZ_QUESTIONS[current];
  const total = SAMPLE_QUIZ_QUESTIONS.length;

  const answeredCount = useMemo(
    () => Object.values(answers).filter((value) => value !== undefined).length,
    [answers],
  );

  function selectOption(optionIndex: number) {
    if (disabled) return;
    setAnswers((prev) => ({ ...prev, [question.id]: optionIndex }));
  }

  function toggleFlag() {
    if (disabled) return;
    setFlagged((prev) => {
      const next = new Set(prev);
      if (next.has(question.id)) next.delete(question.id);
      else next.add(question.id);
      return next;
    });
  }

  function goTo(index: number) {
    if (disabled) return;
    setCurrent(Math.max(0, Math.min(total - 1, index)));
  }

  async function handleSubmit() {
    if (disabled) return;
    const unanswered = SAMPLE_QUIZ_QUESTIONS.map((q, i) =>
      answers[q.id] === undefined ? i + 1 : null,
    ).filter((n): n is number => n !== null);

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
        title: "Submit quiz?",
        text: "You will not be able to change your answers after this.",
        confirmButtonText: "Submit",
      });
      if (!confirmed) return;
    }

    onSubmit(answers);
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_auto]">
      <Card aria-disabled={disabled} className={cn(disabled && "opacity-60")}>
        <CardHeader className="flex-row items-start justify-between gap-4">
          <div>
            <CardTitle className="text-lg">
              Question {current + 1} of {total}
            </CardTitle>
            <CardDescription>
              {answeredCount} of {total} answered.
            </CardDescription>
          </div>
          <Button
            type="button"
            variant={flagged.has(question.id) ? "secondary" : "outline"}
            size="sm"
            onClick={toggleFlag}
            disabled={disabled}
            aria-pressed={flagged.has(question.id)}
          >
            {flagged.has(question.id) ? (
              <Flag aria-hidden="true" />
            ) : (
              <FlagOff aria-hidden="true" />
            )}
            {flagged.has(question.id) ? "Flagged for review" : "Flag for review"}
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          <fieldset disabled={disabled}>
            <legend className="mb-3 font-medium">{question.prompt}</legend>
            <div
              role="radiogroup"
              aria-label={`Answer options for question ${current + 1}`}
              className="space-y-2"
            >
              {question.options.map((option, index) => {
                const inputId = `${question.id}-opt-${index}`;
                const selected = answers[question.id] === index;
                return (
                  <label
                    key={inputId}
                    htmlFor={inputId}
                    className={cn(
                      "flex min-h-11 cursor-pointer items-center gap-3 rounded-md border px-3 py-2 text-sm transition-colors",
                      selected ? "border-primary bg-primary/5" : "hover:bg-muted",
                      disabled && "cursor-not-allowed",
                    )}
                  >
                    <input
                      type="radio"
                      id={inputId}
                      name={question.id}
                      value={index}
                      checked={selected}
                      onChange={() => selectOption(index)}
                      disabled={disabled}
                      className="size-4 shrink-0"
                    />
                    {option}
                  </label>
                );
              })}
            </div>
          </fieldset>

          <div className="flex items-center justify-between gap-2 border-t pt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => goTo(current - 1)}
              disabled={disabled || current === 0}
            >
              <ChevronLeft aria-hidden="true" />
              Previous
            </Button>
            <Button
              type="button"
              variant="outline"
              className="lg:hidden"
              onClick={() => setPaletteOpen((prev) => !prev)}
              aria-expanded={paletteOpen}
              aria-controls="question-palette"
            >
              Questions
            </Button>
            {current < total - 1 ? (
              <Button type="button" onClick={() => goTo(current + 1)} disabled={disabled}>
                Next
                <ChevronRight aria-hidden="true" />
              </Button>
            ) : (
              <Button type="button" onClick={handleSubmit} disabled={disabled}>
                Submit quiz
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Card
        id="question-palette"
        className={cn("w-full lg:w-56", !paletteOpen && "hidden lg:block")}
      >
        <CardHeader>
          <CardTitle className="text-sm">Question palette</CardTitle>
          <CardDescription className="text-xs">
            Answered, flagged, and unseen at a glance.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div
            role="group"
            aria-label="Jump to question"
            className="grid grid-cols-5 gap-2 lg:grid-cols-3"
          >
            {SAMPLE_QUIZ_QUESTIONS.map((q, index) => {
              const isAnswered = answers[q.id] !== undefined;
              const isFlagged = flagged.has(q.id);
              const isCurrent = index === current;
              return (
                <button
                  key={q.id}
                  type="button"
                  onClick={() => goTo(index)}
                  disabled={disabled}
                  aria-current={isCurrent ? "true" : undefined}
                  aria-label={`Question ${index + 1}${isAnswered ? ", answered" : ", not answered"}${isFlagged ? ", flagged for review" : ""}`}
                  className={cn(
                    "relative flex size-10 min-h-11 min-w-11 items-center justify-center overflow-hidden rounded-md border text-sm font-medium",
                    isCurrent && "ring-ring ring-2 ring-offset-1",
                    isFlagged
                      ? "border-accent bg-accent/15"
                      : isAnswered
                        ? "border-primary bg-primary/10"
                        : "border-border",
                  )}
                >
                  {/* Corner-fold ribbon: a small triangular wedge flush
                      inside the box's top-right corner (clip-path, not an
                      icon floated outside the bounds) so the flagged state
                      reads as part of the box's own design rather than a
                      tacked-on badge. Shape + color together (never color
                      alone, DESIGN.md §1) — the ribbon's triangular
                      silhouette is itself distinguishable independent of
                      hue, on top of the Flag glyph below the number. */}
                  {isFlagged ? (
                    <span
                      aria-hidden="true"
                      className="bg-accent absolute right-0 top-0 size-3.5 [clip-path:polygon(100%_0,100%_100%,0_0)]"
                    />
                  ) : null}
                  <span className="flex flex-col items-center leading-none">
                    {index + 1}
                    {isFlagged ? (
                      <Flag aria-hidden="true" className="text-accent-foreground mt-0.5 size-2.5" />
                    ) : null}
                  </span>
                </button>
              );
            })}
          </div>
          <ul className="text-muted-foreground mt-4 space-y-1 text-xs">
            <li className="flex items-center gap-2">
              <span
                className="border-primary bg-primary/10 size-3 rounded border"
                aria-hidden="true"
              />{" "}
              Answered
            </li>
            <li className="flex items-center gap-2">
              <span className="border-border size-3 rounded border" aria-hidden="true" /> Not
              answered
            </li>
            <li className="flex items-center gap-2">
              <span
                className="border-accent bg-accent/15 relative size-3 overflow-hidden rounded border"
                aria-hidden="true"
              >
                <span className="bg-accent absolute right-0 top-0 size-1.5 [clip-path:polygon(100%_0,100%_100%,0_0)]" />
              </span>
              <Flag aria-hidden="true" className="size-3" /> Flagged for review
            </li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
