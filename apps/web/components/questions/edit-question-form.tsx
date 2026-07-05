"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Info, Save } from "lucide-react";

import { addQuestionVersion } from "@/app/dashboard/lecturer/question-banks/actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { QuestionEditor, validateQuestionEditorValue, type QuestionEditorValue } from "@/components/questions/question-editor";
import { notify } from "@/lib/notify";
import { wireShapeToBody } from "@/lib/questions/types";
import type { BankQuestionRow } from "@/lib/supabase/types";

interface EditQuestionFormProps {
  bankId: string;
  question: BankQuestionRow;
}

/**
 * Editing a question means calling add_question_version — see
 * supabase/migrations/20260705000010_question_banks.sql. Category,
 * difficulty, tags, and status are metadata on the `questions` row itself
 * (not versioned content) and are changed elsewhere (category via drag-free
 * reassignment — not yet wired to a dedicated RPC in this phase — status via
 * the retire/reactivate button on the bank detail list). This form only
 * changes prompt/body, which is exactly what create_question_version
 * accepts.
 */
export function EditQuestionForm({ bankId, question }: EditQuestionFormProps) {
  const router = useRouter();
  const [value, setValue] = React.useState<QuestionEditorValue>(() => ({
    type: question.type,
    categoryId: question.category_id,
    difficulty: question.difficulty,
    tags: (question.tags ?? []).join(", "),
    prompt: question.prompt ?? "",
    body: wireShapeToBody(question.type, (question.body ?? {}) as Record<string, unknown>),
  }));
  const [errors, setErrors] = React.useState<string[]>([]);
  const [saving, setSaving] = React.useState(false);

  async function handleSave() {
    const clientErrors = validateQuestionEditorValue(value);
    if (clientErrors.length > 0) {
      setErrors(clientErrors);
      return;
    }
    setErrors([]);

    const confirmed = await notify.confirm({
      title: `Save as version ${(question.version_no ?? 1) + 1}?`,
      text: "The current version stays intact for any past exam attempts that already used it.",
      confirmButtonText: "Save new version",
    });
    if (!confirmed) return;

    setSaving(true);
    try {
      const result = await addQuestionVersion({
        bankId,
        questionId: question.question_id,
        prompt: value.prompt,
        body: value.body,
      });
      if (result.error) {
        await notify.error("Could not save new version", result.error);
        return;
      }
      await notify.success("Saved", `Version ${(question.version_no ?? 1) + 1} created.`);
      router.push(`/dashboard/lecturer/question-banks/${bankId}`);
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="flex items-start gap-2 pt-6 text-sm">
          <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
          <p>
            Editing creates version {(question.version_no ?? 1) + 1}; past exam attempts keep the version
            they were served. Category, difficulty, and tags are not versioned — change them by retiring
            this question and creating a replacement if they need to differ.
          </p>
        </CardContent>
      </Card>

      <QuestionEditor value={value} onChange={setValue} lockType errors={errors} />

      <div className="flex justify-end gap-3">
        <Button type="button" variant="outline" onClick={() => router.back()}>
          Cancel
        </Button>
        <Button type="button" onClick={handleSave} disabled={saving}>
          <Save aria-hidden />
          {saving ? "Saving…" : `Save as version ${(question.version_no ?? 1) + 1}`}
        </Button>
      </div>
    </div>
  );
}
