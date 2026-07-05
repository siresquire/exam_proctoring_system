"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Save } from "lucide-react";

import { createQuestionBank } from "@/app/dashboard/lecturer/question-banks/actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { notify } from "@/lib/notify";

/** Phase 3b: mirrors components/onboarding/new-class-form.tsx exactly. */
export function NewBankForm() {
  const router = useRouter();
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  async function handleSave() {
    if (!name.trim()) {
      await notify.warning("Bank name required", "Give this question bank a name before saving.");
      return;
    }

    setSaving(true);
    try {
      const result = await createQuestionBank(name, description);
      if (result.error) {
        await notify.error("Could not create bank", result.error);
        return;
      }
      await notify.success("Bank created", "You can now add categories and questions.");
      router.push(`/dashboard/lecturer/question-banks/${result.id}`);
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        <div className="space-y-2">
          <Label htmlFor="bank-name">Bank name</Label>
          <Input
            id="bank-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={200}
            placeholder="Data Structures — Midterm pool"
            className="min-h-11"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="bank-description">Description (optional)</Label>
          <Input
            id="bank-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={500}
            placeholder="Covers weeks 1-6"
            className="min-h-11"
          />
        </div>
        <div className="flex justify-end gap-3 pt-2">
          <Button type="button" variant="outline" onClick={() => router.back()}>
            Cancel
          </Button>
          <Button type="button" onClick={handleSave} disabled={saving}>
            <Save aria-hidden />
            {saving ? "Creating…" : "Create bank"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
