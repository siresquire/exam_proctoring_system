"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Save } from "lucide-react";

import { createQuestion } from "@/app/dashboard/lecturer/question-banks/actions";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { defaultQuestionEditorValue, QuestionEditor, validateQuestionEditorValue } from "@/components/questions/question-editor";
import { flattenCategoriesForSelect } from "@/components/questions/category-select";
import { notify } from "@/lib/notify";
import type { QuestionCategoryRow } from "@/lib/supabase/types";

interface NewQuestionFormProps {
  bankId: string;
  categories: QuestionCategoryRow[];
}

export function NewQuestionForm({ bankId, categories }: NewQuestionFormProps) {
  const router = useRouter();
  const [value, setValue] = React.useState(() => defaultQuestionEditorValue());
  const [errors, setErrors] = React.useState<string[]>([]);
  const [saving, setSaving] = React.useState(false);

  const categoryOptions = flattenCategoriesForSelect(categories);

  async function handleSave() {
    const clientErrors = validateQuestionEditorValue(value);
    if (clientErrors.length > 0) {
      setErrors(clientErrors);
      return;
    }
    setErrors([]);
    setSaving(true);
    try {
      const result = await createQuestion({
        bankId,
        type: value.type,
        categoryId: value.categoryId,
        difficulty: value.difficulty,
        tags: value.tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        prompt: value.prompt,
        body: value.body,
      });
      if (result.error) {
        await notify.error("Could not create question", result.error);
        return;
      }
      await notify.success("Question created", "Version 1 has been saved.");
      router.push(`/dashboard/lecturer/question-banks/${bankId}`);
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="q-category">Category (optional)</Label>
        <select
          id="q-category"
          value={value.categoryId ?? ""}
          onChange={(e) => setValue({ ...value, categoryId: e.target.value || null })}
          className="border-input h-9 w-full max-w-md rounded-lg border bg-transparent px-2.5 py-1 text-sm dark:bg-input/30"
        >
          <option value="">Uncategorized</option>
          {categoryOptions.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </div>

      <QuestionEditor value={value} onChange={setValue} errors={errors} />

      <div className="flex justify-end gap-3">
        <Button type="button" variant="outline" onClick={() => router.back()}>
          Cancel
        </Button>
        <Button type="button" onClick={handleSave} disabled={saving}>
          <Save aria-hidden />
          {saving ? "Saving…" : "Create question"}
        </Button>
      </div>
    </div>
  );
}
