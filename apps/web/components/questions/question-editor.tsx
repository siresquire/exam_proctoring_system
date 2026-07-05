"use client";

import * as React from "react";
import { AlertCircle, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  QUESTION_TYPE_LABELS,
  newOptionId,
  type McqOption,
  type QuestionBody,
  type QuestionDifficulty,
  type QuestionType,
} from "@/lib/questions/types";

export interface QuestionEditorValue {
  type: QuestionType;
  categoryId: string | null;
  difficulty: QuestionDifficulty;
  tags: string;
  prompt: string;
  body: QuestionBody;
}

function defaultBodyFor(type: QuestionType): QuestionBody {
  switch (type) {
    case "mcq_single":
    case "mcq_multi":
      return {
        type,
        value: {
          options: [
            { id: "A", text: "" },
            { id: "B", text: "" },
          ],
          correct: [],
          marks: 1,
        },
      };
    case "true_false":
      return { type, value: { correct: true, marks: 1 } };
    case "numeric":
      return { type, value: { correct: 0, tolerance: 0, marks: 1 } };
    case "short_answer":
      return { type, value: { accepted: [""], caseSensitive: false, marks: 1 } };
    case "essay":
      return { type, value: { marks: 1, rubric: "" } };
  }
}

export function defaultQuestionEditorValue(type: QuestionType = "mcq_single"): QuestionEditorValue {
  return { type, categoryId: null, difficulty: "medium", tags: "", prompt: "", body: defaultBodyFor(type) };
}

/** Validates the editor value client-side before submit; mirrors (but does not replace) the server-side RPC validation. Returns a list of error messages (empty = valid). */
export function validateQuestionEditorValue(value: QuestionEditorValue): string[] {
  const errors: string[] = [];
  if (!value.prompt.trim()) errors.push("Prompt is required.");

  if (value.body.type === "mcq_single" || value.body.type === "mcq_multi") {
    const { options, correct, marks } = value.body.value;
    const filled = options.filter((o) => o.text.trim());
    if (filled.length < 2) errors.push("Add at least 2 options.");
    if (correct.length === 0) errors.push("Mark at least one option as correct.");
    if (value.body.type === "mcq_single" && correct.length > 1) {
      errors.push("Single-answer MCQ can only have one correct option.");
    }
    if (!(marks > 0)) errors.push("Marks must be greater than 0.");
  } else if (value.body.type === "numeric") {
    if (!(value.body.value.marks > 0)) errors.push("Marks must be greater than 0.");
    if (value.body.value.tolerance < 0) errors.push("Tolerance cannot be negative.");
  } else if (value.body.type === "short_answer") {
    const filled = value.body.value.accepted.filter((a) => a.trim());
    if (filled.length === 0) errors.push("Add at least 1 accepted answer.");
    if (!(value.body.value.marks > 0)) errors.push("Marks must be greater than 0.");
  } else if (value.body.type === "true_false" || value.body.type === "essay") {
    if (!(value.body.value.marks > 0)) errors.push("Marks must be greater than 0.");
  }
  return errors;
}

interface QuestionEditorProps {
  value: QuestionEditorValue;
  onChange: (next: QuestionEditorValue) => void;
  /** Locks the type switch (editing an existing question never changes its type). */
  lockType?: boolean;
  errors?: string[];
}

/**
 * Per-type question authoring editor (PLAN.md Phase 3b). A type switch
 * drives which body sub-editor renders below the shared prompt/marks/
 * difficulty/tags fields. Full a11y: every control has a visible label,
 * option groups use fieldset/legend, errors surface as an error summary
 * (focus-manageable) plus inline aria-describedby text, and MCQ option rows
 * are added/removed with buttons only (DESIGN.md 2.5.7 — no drag-only UI).
 */
export function QuestionEditor({ value, onChange, lockType = false, errors = [] }: QuestionEditorProps) {
  const errorSummaryRef = React.useRef<HTMLDivElement>(null);
  const prevErrorCount = React.useRef(0);

  React.useEffect(() => {
    if (errors.length > 0 && prevErrorCount.current === 0) {
      errorSummaryRef.current?.focus();
    }
    prevErrorCount.current = errors.length;
  }, [errors]);

  function setType(type: QuestionType) {
    onChange({ ...value, type, body: defaultBodyFor(type) });
  }

  function updateBody(body: QuestionBody) {
    onChange({ ...value, body });
  }

  return (
    <div className="space-y-4">
      {errors.length > 0 ? (
        <div
          ref={errorSummaryRef}
          tabIndex={-1}
          role="alert"
          className="border-destructive bg-destructive/5 text-destructive rounded-md border p-4 text-sm"
        >
          <p className="mb-2 flex items-center gap-2 font-medium">
            <AlertCircle aria-hidden className="size-4" />
            Fix the following before saving:
          </p>
          <ul className="list-inside list-disc space-y-1">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Question details</CardTitle>
          <CardDescription>Prompt, type, difficulty, and tags.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="q-type">Question type</Label>
            <select
              id="q-type"
              value={value.type}
              disabled={lockType}
              onChange={(e) => setType(e.target.value as QuestionType)}
              className={cn(
                "border-input focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
                "h-9 w-full max-w-md rounded-lg border bg-transparent px-2.5 py-1 text-sm outline-none transition-colors",
                "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
                "dark:bg-input/30",
              )}
            >
              {Object.entries(QUESTION_TYPE_LABELS).map(([type, label]) => (
                <option key={type} value={type}>
                  {label}
                </option>
              ))}
            </select>
            {lockType ? (
              <p className="text-muted-foreground text-xs">
                Type cannot be changed once created. Retire this question and create a new one instead.
              </p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="q-prompt">Prompt</Label>
            <textarea
              id="q-prompt"
              value={value.prompt}
              onChange={(e) => onChange({ ...value, prompt: e.target.value })}
              rows={3}
              className="border-input focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 min-h-24 w-full rounded-lg border bg-transparent px-3 py-2 text-sm outline-none transition-colors dark:bg-input/30"
              placeholder="What is..."
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="q-difficulty">Difficulty</Label>
              <select
                id="q-difficulty"
                value={value.difficulty}
                onChange={(e) => onChange({ ...value, difficulty: e.target.value as QuestionDifficulty })}
                className="border-input focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 h-9 w-full rounded-lg border bg-transparent px-2.5 py-1 text-sm outline-none transition-colors dark:bg-input/30"
              >
                <option value="easy">Easy</option>
                <option value="medium">Medium</option>
                <option value="hard">Hard</option>
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="q-tags">Tags (comma-separated)</Label>
              <Input
                id="q-tags"
                value={value.tags}
                onChange={(e) => onChange({ ...value, tags: e.target.value })}
                placeholder="week3, recursion"
                className="min-h-11"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {(value.body.type === "mcq_single" || value.body.type === "mcq_multi") && (
        <McqBodyEditor body={value.body} onChange={updateBody} />
      )}
      {value.body.type === "true_false" && <TrueFalseBodyEditor body={value.body} onChange={updateBody} />}
      {value.body.type === "numeric" && <NumericBodyEditor body={value.body} onChange={updateBody} />}
      {value.body.type === "short_answer" && <ShortAnswerBodyEditor body={value.body} onChange={updateBody} />}
      {value.body.type === "essay" && <EssayBodyEditor body={value.body} onChange={updateBody} />}
    </div>
  );
}

function MarksField({ marks, onChange }: { marks: number; onChange: (marks: number) => void }) {
  return (
    <div className="space-y-2">
      <Label htmlFor="q-marks">Marks</Label>
      <Input
        id="q-marks"
        type="number"
        min={0.5}
        step={0.5}
        inputMode="decimal"
        value={marks}
        onChange={(e) => onChange(Number(e.target.value))}
        className="min-h-11 max-w-32"
      />
    </div>
  );
}

function McqBodyEditor({
  body,
  onChange,
}: {
  body: Extract<QuestionBody, { type: "mcq_single" | "mcq_multi" }>;
  onChange: (body: QuestionBody) => void;
}) {
  const { options, correct, marks } = body.value;
  const isMulti = body.type === "mcq_multi";

  function updateOption(id: string, text: string) {
    onChange({ ...body, value: { ...body.value, options: options.map((o) => (o.id === id ? { ...o, text } : o)) } });
  }

  function addOption() {
    const id = newOptionId(options);
    onChange({ ...body, value: { ...body.value, options: [...options, { id, text: "" }] } });
  }

  function removeOption(id: string) {
    onChange({
      ...body,
      value: { ...body.value, options: options.filter((o) => o.id !== id), correct: correct.filter((c) => c !== id) },
    });
  }

  function toggleCorrect(id: string, checked: boolean) {
    if (isMulti) {
      onChange({
        ...body,
        value: { ...body.value, correct: checked ? [...correct, id] : correct.filter((c) => c !== id) },
      });
    } else {
      onChange({ ...body, value: { ...body.value, correct: checked ? [id] : [] } });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Options</CardTitle>
        <CardDescription>
          {isMulti
            ? "Add options and check every correct answer."
            : "Add options and select the single correct answer."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <fieldset className="space-y-2">
          <legend className="sr-only">Answer options</legend>
          {options.map((option: McqOption) => {
            const isCorrect = correct.includes(option.id);
            return (
              <div key={option.id} className="flex items-center gap-2">
                {isMulti ? (
                  <Checkbox
                    id={`mcq-correct-${option.id}`}
                    checked={isCorrect}
                    onCheckedChange={(checked) => toggleCorrect(option.id, checked === true)}
                    aria-label={`Option ${option.id} is correct`}
                  />
                ) : (
                  <input
                    type="radio"
                    id={`mcq-correct-${option.id}`}
                    name="mcq-correct"
                    checked={isCorrect}
                    onChange={() => toggleCorrect(option.id, true)}
                    aria-label={`Option ${option.id} is the correct answer`}
                    className="size-4 shrink-0"
                  />
                )}
                <Label htmlFor={`mcq-option-text-${option.id}`} className="sr-only">
                  Option {option.id} text
                </Label>
                <Input
                  id={`mcq-option-text-${option.id}`}
                  value={option.text}
                  onChange={(e) => updateOption(option.id, e.target.value)}
                  placeholder={`Option ${option.id}`}
                  className="min-h-11 flex-1"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => removeOption(option.id)}
                  disabled={options.length <= 2}
                  aria-label={`Remove option ${option.id}`}
                  className="size-9 shrink-0"
                >
                  <Trash2 aria-hidden className="size-4" />
                </Button>
              </div>
            );
          })}
        </fieldset>
        <Button type="button" variant="outline" size="sm" onClick={addOption}>
          <Plus aria-hidden className="size-4" />
          Add option
        </Button>
        <MarksField marks={marks} onChange={(m) => onChange({ ...body, value: { ...body.value, marks: m } })} />
      </CardContent>
    </Card>
  );
}

function TrueFalseBodyEditor({
  body,
  onChange,
}: {
  body: Extract<QuestionBody, { type: "true_false" }>;
  onChange: (body: QuestionBody) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Answer</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <fieldset>
          <legend className="mb-2 text-sm font-medium">Correct answer</legend>
          <div role="radiogroup" aria-label="Correct answer" className="flex gap-4">
            {(["true", "false"] as const).map((opt) => (
              <label key={opt} htmlFor={`tf-${opt}`} className="flex min-h-11 cursor-pointer items-center gap-2 text-sm">
                <input
                  type="radio"
                  id={`tf-${opt}`}
                  name="tf-correct"
                  checked={body.value.correct === (opt === "true")}
                  onChange={() => onChange({ ...body, value: { ...body.value, correct: opt === "true" } })}
                  className="size-4"
                />
                {opt === "true" ? "True" : "False"}
              </label>
            ))}
          </div>
        </fieldset>
        <MarksField marks={body.value.marks} onChange={(m) => onChange({ ...body, value: { ...body.value, marks: m } })} />
      </CardContent>
    </Card>
  );
}

function NumericBodyEditor({
  body,
  onChange,
}: {
  body: Extract<QuestionBody, { type: "numeric" }>;
  onChange: (body: QuestionBody) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Answer</CardTitle>
        <CardDescription>A submitted answer is correct within ± tolerance of the value.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor="numeric-correct">Correct value</Label>
          <Input
            id="numeric-correct"
            type="number"
            inputMode="decimal"
            value={body.value.correct}
            onChange={(e) => onChange({ ...body, value: { ...body.value, correct: Number(e.target.value) } })}
            className="min-h-11"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="numeric-tolerance">Tolerance (±)</Label>
          <Input
            id="numeric-tolerance"
            type="number"
            min={0}
            inputMode="decimal"
            value={body.value.tolerance}
            onChange={(e) => onChange({ ...body, value: { ...body.value, tolerance: Number(e.target.value) } })}
            className="min-h-11"
          />
        </div>
        <MarksField marks={body.value.marks} onChange={(m) => onChange({ ...body, value: { ...body.value, marks: m } })} />
      </CardContent>
    </Card>
  );
}

function ShortAnswerBodyEditor({
  body,
  onChange,
}: {
  body: Extract<QuestionBody, { type: "short_answer" }>;
  onChange: (body: QuestionBody) => void;
}) {
  const { accepted, caseSensitive, marks } = body.value;

  function updateAccepted(index: number, text: string) {
    onChange({ ...body, value: { ...body.value, accepted: accepted.map((a, i) => (i === index ? text : a)) } });
  }
  function addAccepted() {
    onChange({ ...body, value: { ...body.value, accepted: [...accepted, ""] } });
  }
  function removeAccepted(index: number) {
    onChange({ ...body, value: { ...body.value, accepted: accepted.filter((_, i) => i !== index) } });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Accepted answers</CardTitle>
        <CardDescription>Any one of these matches. Used for optional auto-grading later.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <fieldset className="space-y-2">
          <legend className="sr-only">Accepted answers</legend>
          {accepted.map((text, index) => (
            <div key={index} className="flex items-center gap-2">
              <Label htmlFor={`accepted-${index}`} className="sr-only">
                Accepted answer {index + 1}
              </Label>
              <Input
                id={`accepted-${index}`}
                value={text}
                onChange={(e) => updateAccepted(index, e.target.value)}
                placeholder={`Accepted answer ${index + 1}`}
                className="min-h-11 flex-1"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => removeAccepted(index)}
                disabled={accepted.length <= 1}
                aria-label={`Remove accepted answer ${index + 1}`}
                className="size-9 shrink-0"
              >
                <Trash2 aria-hidden className="size-4" />
              </Button>
            </div>
          ))}
        </fieldset>
        <Button type="button" variant="outline" size="sm" onClick={addAccepted}>
          <Plus aria-hidden className="size-4" />
          Add accepted answer
        </Button>
        <div className="flex items-center gap-2">
          <Checkbox
            id="case-sensitive"
            checked={caseSensitive}
            onCheckedChange={(checked) => onChange({ ...body, value: { ...body.value, caseSensitive: checked === true } })}
          />
          <Label htmlFor="case-sensitive" className="text-sm font-normal">
            Case-sensitive matching
          </Label>
        </div>
        <MarksField marks={marks} onChange={(m) => onChange({ ...body, value: { ...body.value, marks: m } })} />
      </CardContent>
    </Card>
  );
}

function EssayBodyEditor({
  body,
  onChange,
}: {
  body: Extract<QuestionBody, { type: "essay" }>;
  onChange: (body: QuestionBody) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Grading rubric</CardTitle>
        <CardDescription>Essays are always manually graded (Phase 3d).</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="essay-rubric">Rubric</Label>
          <textarea
            id="essay-rubric"
            value={body.value.rubric}
            onChange={(e) => onChange({ ...body, value: { ...body.value, rubric: e.target.value } })}
            rows={4}
            className="border-input focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 min-h-24 w-full rounded-lg border bg-transparent px-3 py-2 text-sm outline-none transition-colors dark:bg-input/30"
            placeholder="Award marks for: thesis clarity, use of evidence, structure..."
          />
        </div>
        <MarksField marks={body.value.marks} onChange={(m) => onChange({ ...body, value: { ...body.value, marks: m } })} />
      </CardContent>
    </Card>
  );
}
