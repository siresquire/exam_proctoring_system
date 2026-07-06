"use client";

import { useEffect, useId, useState } from "react";
import { Loader2, PlusCircle } from "lucide-react";

import { addSectionSource, fetchPoolAvailableCount } from "@/app/dashboard/lecturer/exams/actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DIFFICULTY_FILTER_LABELS } from "@/lib/exams/types";
import { notify } from "@/lib/notify";
import { QUESTION_TYPE_LABELS } from "@/lib/questions/types";
import type { BankQuestionRow, QuestionBankRow, QuestionCategoryRow, QuestionDifficultyDb } from "@/lib/supabase/types";

interface AddSourceFormProps {
  examId: string;
  sectionId: string;
  banks: QuestionBankRow[];
  questionsByBank: Record<string, BankQuestionRow[]>;
  categoriesByBank: Record<string, QuestionCategoryRow[]>;
  onAdded: () => void;
}

type Mode = "fixed" | "pool";

/**
 * Per-section "add a source" panel with two modes (task brief): "pick
 * specific questions" (browse a bank's 3b questions, select one at a time —
 * add_section_source is single-question per call, so the multi-select is
 * really "add several fixed sources in a row") and "draw N from pool" (bank
 * + optional category/difficulty/tags + count, with a live "X matching
 * available" indicator via pool_available_count).
 */
export function AddSourceForm({ examId, sectionId, banks, questionsByBank, categoriesByBank, onAdded }: AddSourceFormProps) {
  const bankFieldId = useId();
  const questionFieldId = useId();
  const categoryFieldId = useId();
  const difficultyFieldId = useId();
  const tagsFieldId = useId();
  const drawCountFieldId = useId();

  const [mode, setMode] = useState<Mode>("fixed");
  const [bankId, setBankId] = useState(banks[0]?.id ?? "");
  const [questionId, setQuestionId] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [difficulty, setDifficulty] = useState("");
  const [tagsInput, setTagsInput] = useState("");
  const [drawCount, setDrawCount] = useState("1");
  const [available, setAvailable] = useState<number | null>(null);
  const [checkingAvailable, setCheckingAvailable] = useState(false);
  const [saving, setSaving] = useState(false);

  const questions = questionsByBank[bankId] ?? [];
  const categories = categoriesByBank[bankId] ?? [];
  const activeQuestions = questions.filter((q) => q.status === "active");

  const poolCheckActive = mode === "pool" && Boolean(bankId);

  useEffect(() => {
    if (!poolCheckActive) {
      return;
    }
    let cancelled = false;
    const tags = tagsInput
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    // The initial "checking" flag is set from a microtask rather than
    // synchronously in the effect body — react-hooks/set-state-in-effect
    // flags any direct setState call in an effect body (even one guarding a
    // subsequent async call) as a cascading-render risk. Queuing it instead
    // still runs before the fetch's own .then()/.finally() settles (a
    // network round trip is always slower than a microtask), so the loading
    // indicator still appears with no perceptible delay.
    Promise.resolve().then(() => {
      if (!cancelled) setCheckingAvailable(true);
    });
    fetchPoolAvailableCount(bankId, categoryId || null, difficulty || null, tags.length ? tags : null)
      .then((result) => {
        if (cancelled) return;
        setAvailable(result.count ?? 0);
      })
      .finally(() => {
        if (!cancelled) setCheckingAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, [poolCheckActive, bankId, categoryId, difficulty, tagsInput]);

  async function handleAdd() {
    if (!bankId && mode === "pool") {
      await notify.warning("Bank required", "Choose a question bank to draw from.");
      return;
    }
    if (mode === "fixed" && !questionId) {
      await notify.warning("Question required", "Choose a question to add.");
      return;
    }
    const count = Number(drawCount);
    if (mode === "pool" && (!Number.isFinite(count) || count <= 0)) {
      await notify.warning("Invalid count", "Draw count must be a positive number.");
      return;
    }

    setSaving(true);
    try {
      const tags = tagsInput
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);

      const result = await addSectionSource({
        examId,
        sectionId,
        sourceType: mode,
        questionId: mode === "fixed" ? questionId : null,
        bankId: mode === "pool" ? bankId : null,
        categoryId: mode === "pool" ? categoryId || null : null,
        difficulty: mode === "pool" && difficulty ? (difficulty as QuestionDifficultyDb) : null,
        tags: mode === "pool" && tags.length ? tags : null,
        drawCount: mode === "pool" ? count : null,
      });
      if (result.error) {
        await notify.error("Could not add source", result.error);
        return;
      }
      await notify.toast({ title: mode === "fixed" ? "Question added" : "Pool draw added" });
      setQuestionId("");
      onAdded();
    } finally {
      setSaving(false);
    }
  }

  if (banks.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        Create a question bank with some questions first (Question banks in the sidebar) before
        adding sources here.
      </p>
    );
  }

  return (
    <Card className="bg-muted/30">
      <CardHeader>
        <CardTitle className="text-sm">Add a question source</CardTitle>
        <CardDescription>Pick specific questions, or draw a random number from a pool.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <fieldset>
          <legend className="sr-only">Source type</legend>
          <div role="radiogroup" aria-label="Source type" className="flex gap-2">
            <Button type="button" size="sm" variant={mode === "fixed" ? "default" : "outline"} aria-pressed={mode === "fixed"} onClick={() => setMode("fixed")}>
              Pick specific questions
            </Button>
            <Button type="button" size="sm" variant={mode === "pool" ? "default" : "outline"} aria-pressed={mode === "pool"} onClick={() => setMode("pool")}>
              Draw N from pool
            </Button>
          </div>
        </fieldset>

        <div className="space-y-2">
          <Label htmlFor={bankFieldId}>Question bank</Label>
          <select
            id={bankFieldId}
            value={bankId}
            onChange={(e) => {
              setBankId(e.target.value);
              setQuestionId("");
              setCategoryId("");
            }}
            className="border-input focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 h-9 w-full rounded-lg border bg-transparent px-2.5 py-1 text-sm outline-none transition-colors dark:bg-input/30"
          >
            {banks.map((bank) => (
              <option key={bank.id} value={bank.id}>
                {bank.name}
              </option>
            ))}
          </select>
        </div>

        {mode === "fixed" ? (
          <div className="space-y-2">
            <Label htmlFor={questionFieldId}>Question</Label>
            <select
              id={questionFieldId}
              value={questionId}
              onChange={(e) => setQuestionId(e.target.value)}
              className="border-input focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 h-9 w-full rounded-lg border bg-transparent px-2.5 py-1 text-sm outline-none transition-colors dark:bg-input/30"
            >
              <option value="">Choose a question…</option>
              {activeQuestions.map((q) => (
                <option key={q.question_id} value={q.question_id}>
                  [{QUESTION_TYPE_LABELS[q.type]}] {q.prompt?.slice(0, 70)}
                </option>
              ))}
            </select>
            {activeQuestions.length === 0 ? (
              <p className="text-muted-foreground text-sm">This bank has no active questions yet.</p>
            ) : null}
          </div>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor={categoryFieldId}>Category (optional)</Label>
                <select
                  id={categoryFieldId}
                  value={categoryId}
                  onChange={(e) => setCategoryId(e.target.value)}
                  className="border-input h-9 w-full rounded-lg border bg-transparent px-2.5 py-1 text-sm dark:bg-input/30"
                >
                  <option value="">Any category</option>
                  {categories.map((cat) => (
                    <option key={cat.id} value={cat.id}>
                      {cat.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor={difficultyFieldId}>Difficulty (optional)</Label>
                <select
                  id={difficultyFieldId}
                  value={difficulty}
                  onChange={(e) => setDifficulty(e.target.value)}
                  className="border-input h-9 w-full rounded-lg border bg-transparent px-2.5 py-1 text-sm dark:bg-input/30"
                >
                  <option value="">Any difficulty</option>
                  {Object.entries(DIFFICULTY_FILTER_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor={tagsFieldId}>Tags (optional, comma-separated)</Label>
              <Input id={tagsFieldId} value={tagsInput} onChange={(e) => setTagsInput(e.target.value)} placeholder="arrays, week3" className="min-h-11" />
            </div>
            <div className="space-y-2">
              <Label htmlFor={drawCountFieldId}>Number of questions to draw</Label>
              <Input
                id={drawCountFieldId}
                type="number"
                min={1}
                inputMode="numeric"
                value={drawCount}
                onChange={(e) => setDrawCount(e.target.value)}
                className="min-h-11 max-w-32"
              />
            </div>
            <p className="text-sm" role="status" aria-live="polite">
              {checkingAvailable ? (
                <span className="text-muted-foreground inline-flex items-center gap-1.5">
                  <Loader2 aria-hidden className="size-3.5 animate-spin" />
                  Checking availability…
                </span>
              ) : available !== null ? (
                <span className={available < Number(drawCount) ? "text-destructive font-medium" : "text-muted-foreground"}>
                  {available} matching question{available === 1 ? "" : "s"} available
                  {available < Number(drawCount) ? " — not enough for this draw count" : ""}
                </span>
              ) : null}
            </p>
          </>
        )}

        <div className="flex justify-end">
          <Button type="button" size="sm" onClick={handleAdd} disabled={saving}>
            <PlusCircle aria-hidden />
            {saving ? "Adding…" : "Add source"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
