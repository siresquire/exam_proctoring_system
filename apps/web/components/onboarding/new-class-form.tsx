"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Save } from "lucide-react";

import { createClass } from "@/app/dashboard/lecturer/classes/actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { notify } from "@/lib/notify";

export function NewClassForm() {
  const router = useRouter();
  const [name, setName] = React.useState("");
  const [code, setCode] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  async function handleSave() {
    if (!name.trim()) {
      await notify.warning("Class name required", "Give this class a name before saving.");
      return;
    }

    setSaving(true);
    try {
      const result = await createClass(name, code, description);
      if (result.error) {
        await notify.error("Could not create class", result.error);
        return;
      }
      await notify.success("Class created", "You can now import students.");
      router.push(`/dashboard/lecturer/classes/${result.id}`);
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        <div className="space-y-2">
          <Label htmlFor="class-name">Class name</Label>
          <Input
            id="class-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={200}
            placeholder="BSc Computer Science — Year 2"
            className="min-h-11"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="class-code">Class code (optional)</Label>
          <Input
            id="class-code"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            maxLength={40}
            placeholder="CS201-A"
            className="min-h-11 font-mono text-sm"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="class-description">Description (optional)</Label>
          <Input
            id="class-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={500}
            placeholder="Semester 1, 2026/27"
            className="min-h-11"
          />
        </div>
        <div className="flex justify-end gap-3 pt-2">
          <Button type="button" variant="outline" onClick={() => router.back()}>
            Cancel
          </Button>
          <Button type="button" onClick={handleSave} disabled={saving}>
            <Save aria-hidden />
            {saving ? "Creating…" : "Create class"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
