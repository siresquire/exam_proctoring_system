"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Save } from "lucide-react";

import { createExam } from "@/app/dashboard/lecturer/exams/actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { notify } from "@/lib/notify";
import type { ClassRow } from "@/lib/supabase/types";

interface NewExamFormProps {
  classes: ClassRow[];
}

export function NewExamForm({ classes }: NewExamFormProps) {
  const router = useRouter();
  const [title, setTitle] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [classId, setClassId] = React.useState<string>("");
  const [saving, setSaving] = React.useState(false);

  async function handleSave() {
    if (!title.trim()) {
      await notify.warning("Title required", "Give this exam a title before saving.");
      return;
    }

    setSaving(true);
    try {
      const result = await createExam(title, description, classId || null);
      if (result.error) {
        await notify.error("Could not create exam", result.error);
        return;
      }
      await notify.success("Exam created", "Now build its sections and settings.");
      router.push(`/dashboard/lecturer/exams/${result.id}`);
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        <div className="space-y-2">
          <Label htmlFor="exam-title">Title</Label>
          <Input
            id="exam-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={200}
            placeholder="Midterm — Data Structures"
            className="min-h-11"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="exam-description">Description (optional)</Label>
          <Input
            id="exam-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={500}
            placeholder="Covers weeks 1–6"
            className="min-h-11"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="exam-class">Class (optional — required before publishing)</Label>
          <select
            id="exam-class"
            value={classId}
            onChange={(event) => setClassId(event.target.value)}
            className="border-input focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 h-9 w-full rounded-lg border bg-transparent px-2.5 py-1 text-sm outline-none transition-colors dark:bg-input/30"
          >
            <option value="">No class assigned yet</option>
            {classes.map((klass) => (
              <option key={klass.id} value={klass.id}>
                {klass.name}
                {klass.code ? ` (${klass.code})` : ""}
              </option>
            ))}
          </select>
          {classes.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              You have no classes yet. Create one from the Classes page, or assign it later.
            </p>
          ) : null}
        </div>
        <div className="flex justify-end gap-3 pt-2">
          <Button type="button" variant="outline" onClick={() => router.back()}>
            Cancel
          </Button>
          <Button type="button" onClick={handleSave} disabled={saving}>
            <Save aria-hidden />
            {saving ? "Creating…" : "Create exam"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
