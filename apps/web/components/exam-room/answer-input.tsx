"use client";

import { cn } from "@/lib/utils";
import type { AttemptQuestion } from "@/lib/supabase/types";

export type AnswerResponse =
  | { selected: string }
  | { selected: string[] }
  | { selected: boolean }
  | { value: number | string }
  | { text: string }
  | null;

interface AnswerInputProps {
  question: AttemptQuestion;
  response: AnswerResponse;
  onChange: (response: AnswerResponse) => void;
  disabled?: boolean;
}

/**
 * Renders the correct control for a sanitized question slot's type
 * (get_attempt_questions has already stripped every answer-bearing field —
 * options here are bare {id,text}, never `correct`). Mirrors
 * sample-quiz.tsx's native-radio styling for mcq_single so the real exam
 * room and the Phase 1.5 demo read as the same visual language.
 */
export function AnswerInput({ question, response, onChange, disabled }: AnswerInputProps) {
  const body = question.body as { options?: { id: string; text: string }[] } | null;
  const options = body?.options ?? [];

  if (question.type === "mcq_single") {
    const selected = response && "selected" in response ? (response.selected as string) : undefined;
    return (
      <div
        role="radiogroup"
        aria-label={`Answer options for: ${question.prompt}`}
        className="space-y-2"
      >
        {options.map((option) => {
          const inputId = `${question.question_ref}-opt-${option.id}`;
          const isSelected = selected === option.id;
          return (
            <label
              key={inputId}
              htmlFor={inputId}
              className={cn(
                "flex min-h-11 cursor-pointer items-center gap-3 rounded-md border px-3 py-2 text-sm transition-colors",
                isSelected ? "border-primary bg-primary/5" : "hover:bg-muted",
                disabled && "cursor-not-allowed opacity-60",
              )}
            >
              <input
                type="radio"
                id={inputId}
                name={question.question_ref}
                value={option.id}
                checked={isSelected}
                onChange={() => onChange({ selected: option.id })}
                disabled={disabled}
                className="size-4 shrink-0"
              />
              {option.text}
            </label>
          );
        })}
      </div>
    );
  }

  if (question.type === "mcq_multi") {
    const selected = response && "selected" in response ? (response.selected as string[]) : [];
    const selectedSet = new Set(Array.isArray(selected) ? selected : []);
    return (
      <div
        role="group"
        aria-label={`Answer options for: ${question.prompt} (select all that apply)`}
        className="space-y-2"
      >
        {options.map((option) => {
          const inputId = `${question.question_ref}-opt-${option.id}`;
          const isSelected = selectedSet.has(option.id);
          return (
            <label
              key={inputId}
              htmlFor={inputId}
              className={cn(
                "flex min-h-11 cursor-pointer items-center gap-3 rounded-md border px-3 py-2 text-sm transition-colors",
                isSelected ? "border-primary bg-primary/5" : "hover:bg-muted",
                disabled && "cursor-not-allowed opacity-60",
              )}
            >
              <input
                type="checkbox"
                id={inputId}
                name={inputId}
                checked={isSelected}
                onChange={(event) => {
                  const next = new Set(selectedSet);
                  if (event.target.checked) next.add(option.id);
                  else next.delete(option.id);
                  onChange({ selected: Array.from(next) });
                }}
                disabled={disabled}
                className="size-4 shrink-0"
              />
              {option.text}
            </label>
          );
        })}
      </div>
    );
  }

  if (question.type === "true_false") {
    const selected = response && "selected" in response ? (response.selected as boolean) : undefined;
    return (
      <div
        role="radiogroup"
        aria-label={`Answer for: ${question.prompt}`}
        className="flex gap-3"
      >
        {[
          { id: "true", label: "True", value: true },
          { id: "false", label: "False", value: false },
        ].map((option) => {
          const inputId = `${question.question_ref}-${option.id}`;
          const isSelected = selected === option.value;
          return (
            <label
              key={inputId}
              htmlFor={inputId}
              className={cn(
                "flex min-h-11 flex-1 cursor-pointer items-center justify-center gap-3 rounded-md border px-3 py-2 text-sm font-medium transition-colors",
                isSelected ? "border-primary bg-primary/5" : "hover:bg-muted",
                disabled && "cursor-not-allowed opacity-60",
              )}
            >
              <input
                type="radio"
                id={inputId}
                name={question.question_ref}
                checked={isSelected}
                onChange={() => onChange({ selected: option.value })}
                disabled={disabled}
                className="size-4 shrink-0"
              />
              {option.label}
            </label>
          );
        })}
      </div>
    );
  }

  if (question.type === "numeric") {
    const value = response && "value" in response ? response.value : "";
    return (
      <div className="max-w-xs">
        <label htmlFor={`${question.question_ref}-numeric`} className="sr-only">
          Numeric answer for: {question.prompt}
        </label>
        <input
          id={`${question.question_ref}-numeric`}
          type="number"
          inputMode="decimal"
          value={value ?? ""}
          onChange={(event) => onChange(event.target.value === "" ? null : { value: event.target.value })}
          disabled={disabled}
          className="border-input focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 h-11 w-full rounded-lg border bg-transparent px-3 text-base outline-none transition-colors disabled:opacity-50"
          placeholder="Enter a number"
        />
      </div>
    );
  }

  if (question.type === "short_answer") {
    const text = response && "text" in response ? (response.text as string) : "";
    return (
      <div>
        <label htmlFor={`${question.question_ref}-short`} className="sr-only">
          Short answer for: {question.prompt}
        </label>
        <input
          id={`${question.question_ref}-short`}
          type="text"
          value={text}
          onChange={(event) => onChange(event.target.value === "" ? null : { text: event.target.value })}
          disabled={disabled}
          className="border-input focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 h-11 w-full rounded-lg border bg-transparent px-3 text-base outline-none transition-colors disabled:opacity-50"
          placeholder="Type your answer"
        />
      </div>
    );
  }

  // essay
  const text = response && "text" in response ? (response.text as string) : "";
  return (
    <div>
      <label htmlFor={`${question.question_ref}-essay`} className="sr-only">
        Essay answer for: {question.prompt}
      </label>
      <textarea
        id={`${question.question_ref}-essay`}
        value={text}
        onChange={(event) => onChange(event.target.value === "" ? null : { text: event.target.value })}
        disabled={disabled}
        rows={10}
        className="border-input focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 w-full rounded-lg border bg-transparent px-3 py-2 text-base outline-none transition-colors disabled:opacity-50"
        placeholder="Write your answer"
      />
    </div>
  );
}
