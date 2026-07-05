"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, CheckCircle2, FileDown, Upload } from "lucide-react";

import {
  commitQuestionImport,
  previewQuestionImport,
  type ImportFormat,
} from "@/app/dashboard/lecturer/question-banks/[id]/import/actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { notify } from "@/lib/notify";
import { downloadCsv } from "@/lib/onboarding/roster-export";
import { CSV_TEMPLATE } from "@/lib/questions/import/csv";
import { AIKEN_TEMPLATE } from "@/lib/questions/import/aiken";
import { GIFT_TEMPLATE } from "@/lib/questions/import/gift";
import type { ParsedQuestionRow } from "@/lib/questions/import/types";
import { QUESTION_TYPE_LABELS } from "@/lib/questions/types";

interface QuestionImportFormProps {
  bankId: string;
}

const FORMAT_LABELS: Record<ImportFormat, string> = {
  csv: "CSV / TSV",
  aiken: "Aiken",
  gift: "GIFT (subset)",
};

const FORMAT_TEMPLATES: Record<ImportFormat, string> = {
  csv: CSV_TEMPLATE,
  aiken: AIKEN_TEMPLATE,
  gift: GIFT_TEMPLATE,
};

const FORMAT_HELP: Record<ImportFormat, string> = {
  csv: "Columns: type, prompt, options, correct, difficulty, tags, marks, category. options/accepted answers are pipe- or semicolon-separated; correct is a 1-based index or letter for MCQ.",
  aiken: 'Classic Aiken MCQ format: a prompt line, "A. option" lines, then "ANSWER: A". Every item becomes single-answer multiple choice.',
  gift: "A subset of Moodle GIFT: multiple choice ({=correct ~wrong}), true/false ({TRUE}/{FALSE}), short answer ({=ans1 =ans2}), numeric ({#answer:tolerance}). Per-option weights and empty {} essay items are rejected, not silently imported — see the README for the full supported/unsupported list.",
};

type Step = "input" | "preview" | "done";

export function QuestionImportForm({ bankId }: QuestionImportFormProps) {
  const router = useRouter();
  const [format, setFormat] = React.useState<ImportFormat>("csv");
  const [text, setText] = React.useState("");
  const [step, setStep] = React.useState<Step>("input");
  const [preview, setPreview] = React.useState<ParsedQuestionRow[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [result, setResult] = React.useState<{ imported: number; skipped: number } | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  function reset() {
    setStep("input");
    setPreview([]);
    setResult(null);
  }

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setText(await file.text());
  }

  async function handlePreview() {
    if (!text.trim()) {
      await notify.warning("Nothing to preview", "Paste content or choose a file first.");
      return;
    }
    setLoading(true);
    try {
      const res = await previewQuestionImport(format, text);
      if (res.error) {
        await notify.error("Could not parse this content", res.error);
        return;
      }
      setPreview(res.rows ?? []);
      setStep("preview");
    } finally {
      setLoading(false);
    }
  }

  async function handleConfirm() {
    setLoading(true);
    try {
      const res = await commitQuestionImport(bankId, format, text);
      if (res.error) {
        await notify.error("Import failed", res.error);
        return;
      }
      setResult({ imported: res.imported ?? 0, skipped: res.skipped ?? 0 });
      setStep("done");
      await notify.success(
        "Import complete",
        `Imported ${res.imported ?? 0} of ${(res.imported ?? 0) + (res.skipped ?? 0)}; ${res.skipped ?? 0} skipped.`,
      );
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  const validCount = preview.filter((r) => r.errors.length === 0 && r.type && r.body).length;
  const invalidCount = preview.length - validCount;

  return (
    <div className="space-y-6">
      {step === "input" ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">1. Choose a format and provide content</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <fieldset>
              <legend className="mb-2 text-sm font-medium">Format</legend>
              <div role="radiogroup" aria-label="Import format" className="flex flex-wrap gap-4">
                {(Object.keys(FORMAT_LABELS) as ImportFormat[]).map((f) => (
                  <label key={f} htmlFor={`format-${f}`} className="flex min-h-11 cursor-pointer items-center gap-2 text-sm">
                    <input
                      type="radio"
                      id={`format-${f}`}
                      name="import-format"
                      checked={format === f}
                      onChange={() => setFormat(f)}
                      className="size-4"
                    />
                    {FORMAT_LABELS[f]}
                  </label>
                ))}
              </div>
            </fieldset>
            <p className="text-muted-foreground text-sm">{FORMAT_HELP[format]}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => downloadCsv(`question-import-template-${format}.txt`, FORMAT_TEMPLATES[format])}
            >
              <FileDown aria-hidden />
              Download {FORMAT_LABELS[format]} template
            </Button>

            <div className="space-y-2">
              <Label htmlFor="import-file">Upload a file (optional)</Label>
              <input
                ref={fileInputRef}
                id="import-file"
                type="file"
                accept=".csv,.tsv,.txt,text/plain,text/csv"
                onChange={handleFileChange}
                className="border-input min-h-11 w-full rounded-lg border bg-transparent px-2.5 py-1.5 text-sm file:mr-3 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-secondary-foreground"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="import-text">Or paste content</Label>
              <textarea
                id="import-text"
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={10}
                className="border-input focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 min-h-48 w-full rounded-lg border bg-transparent px-3 py-2 font-mono text-sm outline-none transition-colors dark:bg-input/30"
                placeholder={FORMAT_TEMPLATES[format]}
              />
            </div>

            <div className="flex justify-end">
              <Button type="button" onClick={handlePreview} disabled={loading}>
                <Upload aria-hidden />
                {loading ? "Parsing…" : "Preview import"}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {step === "preview" ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">2. Review before importing</CardTitle>
            <CardDescription>Nothing has been created yet.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div role="status" className="bg-muted rounded-md p-3 text-sm">
              <span className="font-medium">{validCount}</span> ready to import
              {invalidCount > 0 ? (
                <>
                  , <span className="font-medium">{invalidCount}</span> will be skipped (see reasons below)
                </>
              ) : null}
              .
            </div>
            <div className="max-h-96 overflow-y-auto rounded-md border">
              <Table>
                <TableCaption className="sr-only">Import preview</TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">#</TableHead>
                    <TableHead scope="col">Type</TableHead>
                    <TableHead scope="col">Prompt</TableHead>
                    <TableHead scope="col">Answer</TableHead>
                    <TableHead scope="col">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {preview.map((row) => {
                    const isValid = row.errors.length === 0 && row.type && row.body;
                    return (
                      <TableRow key={row.itemNumber}>
                        <TableCell className="text-muted-foreground text-xs">{row.itemNumber}</TableCell>
                        <TableCell className="text-sm">{row.type ? QUESTION_TYPE_LABELS[row.type] : "—"}</TableCell>
                        <TableCell className="max-w-64 truncate text-sm">{row.prompt || "—"}</TableCell>
                        <TableCell className="max-w-48 truncate text-xs">{summarizeAnswer(row)}</TableCell>
                        <TableCell>
                          {isValid ? (
                            <span className="flex items-center gap-1 text-[oklch(0.4_0.13_155)] text-sm dark:text-[oklch(0.85_0.14_155)]">
                              <CheckCircle2 aria-hidden className="size-3.5" />
                              Ready
                            </span>
                          ) : (
                            <span className="text-destructive flex items-start gap-1 text-sm">
                              <AlertCircle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                              {row.errors.join(" ")}
                            </span>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
            <div className="flex justify-end gap-3">
              <Button type="button" variant="outline" onClick={() => setStep("input")} disabled={loading}>
                Back
              </Button>
              <Button type="button" onClick={handleConfirm} disabled={loading || validCount === 0}>
                {loading ? "Importing…" : `Confirm import (${validCount})`}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {step === "done" && result ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Import complete</CardTitle>
            <CardDescription>
              Imported {result.imported} of {result.imported + result.skipped}; {result.skipped} skipped.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex gap-3">
            <Button type="button" variant="outline" onClick={reset}>
              Import more
            </Button>
            <Button type="button" onClick={() => router.push(`/dashboard/lecturer/question-banks/${bankId}`)}>
              Back to bank
            </Button>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function summarizeAnswer(row: ParsedQuestionRow): string {
  if (!row.body) return "—";
  switch (row.body.type) {
    case "mcq_single":
    case "mcq_multi": {
      const { options, correct } = row.body.value;
      const correctText = options
        .filter((o) => correct.includes(o.id))
        .map((o) => o.text)
        .join(", ");
      return correctText || "—";
    }
    case "true_false":
      return row.body.value.correct ? "True" : "False";
    case "numeric":
      return `${row.body.value.correct} ± ${row.body.value.tolerance}`;
    case "short_answer":
      return row.body.value.accepted.join(" | ");
    case "essay":
      return "(manually graded)";
  }
}
