import { CheckCircle2, Clock, XCircle } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { AttemptResult, AttemptResultQuestion } from "@/lib/supabase/types";

/** Resolves an option id to its display text via the slot's {id,text} options list, when present — falls back to the raw id for types with no option list (numeric/short_answer/essay). */
function optionText(id: string, options?: { id: string; text: string }[] | null): string {
  return options?.find((opt) => opt.id === id)?.text ?? id;
}

function formatAnswer(value: unknown, options?: { id: string; text: string }[] | null): string {
  if (value == null) return "No answer";
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if ("selected" in record) {
      const selected = record.selected;
      if (Array.isArray(selected)) {
        return selected.length > 0 ? selected.map((id) => optionText(String(id), options)).join(", ") : "No answer";
      }
      if (typeof selected === "boolean") return selected ? "True" : "False";
      return optionText(String(selected), options);
    }
    if ("value" in record) return String(record.value);
    if ("text" in record) return String(record.text) || "No answer";
  }
  return String(value);
}

function QuestionBreakdownRow({ question }: { question: AttemptResultQuestion }) {
  if (question.type === "essay") {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{question.prompt}</CardTitle>
          <CardDescription>Essay — {question.max} marks available.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>
            <span className="font-medium">Your answer: </span>
            {formatAnswer(question.response)}
          </p>
          {question.needs_manual_grading ? (
            <p className="text-muted-foreground flex items-center gap-1.5">
              <Clock aria-hidden className="size-4" />
              Not yet graded by your lecturer.
            </p>
          ) : (
            <>
              <p className="font-medium">
                Marks awarded: {question.marks_awarded ?? 0} / {question.max}
              </p>
              {question.feedback ? (
                <p className="bg-secondary/40 rounded-md border p-2">
                  <span className="font-medium">Feedback: </span>
                  {question.feedback}
                </p>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>
    );
  }

  const isCorrect = (question.score ?? 0) >= question.max && question.max > 0;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          {isCorrect ? (
            <CheckCircle2 aria-hidden className="text-primary size-4 shrink-0" />
          ) : (
            <XCircle aria-hidden className="text-destructive size-4 shrink-0" />
          )}
          {question.prompt}
        </CardTitle>
        <CardDescription>
          {question.score ?? 0} / {question.max} marks.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-1 text-sm">
        <p>
          <span className="font-medium">Your answer: </span>
          {formatAnswer(question.response, question.options)}
        </p>
        {!isCorrect && question.correct != null ? (
          <p>
            <span className="font-medium">Correct answer: </span>
            {formatAnswer({ selected: question.correct }, question.options)}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * Phase 3d-ii student result view. Renders whatever get_attempt_result
 * returned — {released:false, reason} shows a friendly waiting state (no
 * score, no per-question data ever reaches this component in that case,
 * since the RPC itself withholds it server-side); {released:true, ...}
 * shows the total + per-question breakdown.
 */
export function AttemptResultView({ examTitle, result }: { examTitle: string; result: AttemptResult }) {
  if (!result.released) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-xl">{examTitle}</CardTitle>
          <CardDescription>Results not yet released</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">
            {result.reason === "not_submitted"
              ? "This attempt has not been submitted yet."
              : "Your lecturer has not released results for this exam yet. Check back later."}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-xl">{examTitle}</CardTitle>
          <CardDescription className="flex items-center gap-2">
            <Badge variant={result.status === "terminated" ? "destructive" : "secondary"}>
              {result.status?.replace("_", " ")}
            </Badge>
            {result.needs_manual_grading ? <Badge variant="outline">Awaiting essay grading</Badge> : null}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm font-medium">Your score</p>
          <p className="text-2xl font-semibold">
            {result.auto_score ?? 0} / {result.max_score ?? 0}
          </p>
        </CardContent>
      </Card>

      <section aria-labelledby="breakdown-heading" className="space-y-4">
        <h2 id="breakdown-heading" className="text-lg font-semibold tracking-tight">
          Question breakdown
        </h2>
        {(result.per_question ?? []).map((question) => (
          <QuestionBreakdownRow key={question.question_ref} question={question} />
        ))}
      </section>
    </div>
  );
}
