"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, ListPlus, Trash2 } from "lucide-react";

import { removeExamSection, removeSectionSource, reorderExamSection } from "@/app/dashboard/lecturer/exams/actions";
import { AddSourceForm } from "@/components/exams/add-source-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { notify } from "@/lib/notify";
import { QUESTION_TYPE_LABELS } from "@/lib/questions/types";
import type { BankQuestionRow, ExamSectionRow, ExamSectionSourceRow, QuestionBankRow, QuestionCategoryRow } from "@/lib/supabase/types";

interface SectionEditorProps {
  examId: string;
  section: ExamSectionRow;
  sources: ExamSectionSourceRow[];
  isFirst: boolean;
  isLast: boolean;
  banks: QuestionBankRow[];
  questionsByBank: Record<string, BankQuestionRow[]>;
  categoriesByBank: Record<string, QuestionCategoryRow[]>;
}

function sourceLabel(
  source: ExamSectionSourceRow,
  questionsByBank: Record<string, BankQuestionRow[]>,
  banks: QuestionBankRow[],
): { title: string; detail: string } {
  if (source.source_type === "fixed") {
    const bank = Object.values(questionsByBank)
      .flat()
      .find((q) => q.question_id === source.question_id);
    return {
      title: bank ? `[${QUESTION_TYPE_LABELS[bank.type]}] ${bank.prompt?.slice(0, 80) ?? "Question"}` : "Fixed question",
      detail: "Fixed pick — same question every attempt",
    };
  }
  const bankName = banks.find((b) => b.id === source.bank_id)?.name ?? "Unknown bank";
  const filters: string[] = [];
  if (source.difficulty) filters.push(`difficulty=${source.difficulty}`);
  if (source.tags?.length) filters.push(`tags=${source.tags.join(",")}`);
  return {
    title: `Draw ${source.draw_count} from "${bankName}"`,
    detail: filters.length ? filters.join(", ") : "No additional filters",
  };
}

/** One section: title/description, its ordered sources, reorder (up/down, keyboard-accessible buttons — never drag-only), remove, and the add-source panel. */
export function SectionEditor({ examId, section, sources, isFirst, isLast, banks, questionsByBank, categoriesByBank }: SectionEditorProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function handleReorder(direction: "up" | "down") {
    setBusy(true);
    try {
      const result = await reorderExamSection(examId, section.id, direction);
      if (result.error) {
        await notify.error("Could not reorder", result.error);
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function handleRemoveSection() {
    const confirmed = await notify.confirm({
      title: "Remove this section?",
      text: `"${section.title}" and all its question sources will be removed.`,
      destructive: true,
      confirmButtonText: "Remove",
    });
    if (!confirmed) return;

    setBusy(true);
    try {
      const result = await removeExamSection(examId, section.id);
      if (result.error) {
        await notify.error("Could not remove section", result.error);
        return;
      }
      await notify.toast({ title: "Section removed" });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function handleRemoveSource(sourceId: string) {
    setBusy(true);
    try {
      const result = await removeSectionSource(examId, sourceId);
      if (result.error) {
        await notify.error("Could not remove source", result.error);
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">{section.title}</CardTitle>
            {section.description ? <p className="text-muted-foreground mt-1 text-sm">{section.description}</p> : null}
          </div>
          <div className="flex shrink-0 gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="icon"
              disabled={isFirst || busy}
              onClick={() => handleReorder("up")}
              aria-label={`Move section "${section.title}" up`}
            >
              <ArrowUp aria-hidden className="size-4" />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon"
              disabled={isLast || busy}
              onClick={() => handleReorder("down")}
              aria-label={`Move section "${section.title}" down`}
            >
              <ArrowDown aria-hidden className="size-4" />
            </Button>
            <Button type="button" variant="outline" size="icon" disabled={busy} onClick={handleRemoveSection} aria-label={`Remove section "${section.title}"`}>
              <Trash2 aria-hidden className="size-4" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {sources.length === 0 ? (
          <p className="text-muted-foreground text-sm">No question sources yet — add one below.</p>
        ) : (
          <ul className="space-y-2">
            {sources.map((source) => {
              const { title, detail } = sourceLabel(source, questionsByBank, banks);
              return (
                <li key={source.id}>
                  <div className="bg-background flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Badge variant={source.source_type === "fixed" ? "outline" : "secondary"}>
                          {source.source_type === "fixed" ? "Fixed" : "Pool"}
                        </Badge>
                        <p className="truncate text-sm font-medium">{title}</p>
                      </div>
                      <p className="text-muted-foreground mt-0.5 text-xs">{detail}</p>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => handleRemoveSource(source.id)}
                      aria-label={`Remove source: ${title}`}
                    >
                      <Trash2 aria-hidden className="size-4" />
                      Remove
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        <AddSourceForm
          examId={examId}
          sectionId={section.id}
          banks={banks}
          questionsByBank={questionsByBank}
          categoriesByBank={categoriesByBank}
          onAdded={() => router.refresh()}
        />
      </CardContent>
    </Card>
  );
}

export function AddSectionButton({ examId, onAdd }: { examId: string; onAdd: (title: string, description: string) => Promise<void> }) {
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleAdd() {
    if (!title.trim()) {
      await notify.warning("Section title required", "Give the new section a title.");
      return;
    }
    setSaving(true);
    try {
      await onAdd(title, "");
      setTitle("");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="border-dashed">
      <CardContent className="flex flex-wrap items-end gap-3 pt-6">
        <div className="min-w-48 flex-1 space-y-2">
          <label htmlFor={`new-section-title-${examId}`} className="text-sm font-medium">
            New section title
          </label>
          <input
            id={`new-section-title-${examId}`}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Section 1 — Multiple choice"
            className="border-input focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 h-9 w-full rounded-lg border bg-transparent px-2.5 py-1 text-sm outline-none transition-colors dark:bg-input/30"
          />
        </div>
        <Button type="button" onClick={handleAdd} disabled={saving}>
          <ListPlus aria-hidden />
          {saving ? "Adding…" : "Add section"}
        </Button>
      </CardContent>
    </Card>
  );
}
