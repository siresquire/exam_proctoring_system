"use client";

import * as React from "react";
import { AlertCircle, FileDown, Upload } from "lucide-react";

import {
  commitRosterImport,
  previewRosterImport,
  sendLoginDetailsBySms,
  type RosterImportOutcomeRow,
  type SmsSendOutcome,
} from "@/app/dashboard/lecturer/classes/actions";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { ROSTER_CSV_TEMPLATE } from "@/lib/onboarding/roster-csv";
import type { RosterRowPreview } from "@/lib/onboarding/roster-csv";

interface RosterImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  classId: string;
  className: string;
  onImported: (imported: RosterImportOutcomeRow[]) => void;
}

const STATUS_LABEL: Record<RosterRowPreview["status"], string> = {
  valid: "Ready to import",
  already_enrolled: "Already enrolled",
  duplicate_in_file: "Duplicate in file",
  bad_index_format: "Bad index format",
  missing_name: "Missing name",
};

type Step = "upload" | "preview" | "done";

/**
 * Phase 3a CSV import flow: upload -> server-validated preview (nothing is
 * created yet) -> explicit confirm -> commit -> results with an SMS-send
 * option. Every step re-validates server-side (previewRosterImport /
 * commitRosterImport re-parse the raw CSV text themselves) — the client's
 * parsed rows are for display only.
 */
export function RosterImportDialog({ open, onOpenChange, classId, className, onImported }: RosterImportDialogProps) {
  const [step, setStep] = React.useState<Step>("upload");
  const [csvText, setCsvText] = React.useState("");
  const [fileName, setFileName] = React.useState<string | null>(null);
  const [preview, setPreview] = React.useState<RosterRowPreview[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [imported, setImported] = React.useState<RosterImportOutcomeRow[]>([]);
  const [smsResults, setSmsResults] = React.useState<SmsSendOutcome[] | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  function reset() {
    setStep("upload");
    setCsvText("");
    setFileName(null);
    setPreview([]);
    setImported([]);
    setSmsResults(null);
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setCsvText(text);
    setFileName(file.name);
  }

  async function handlePreview() {
    if (!csvText.trim()) {
      await notify.warning("Choose a file", "Select a CSV file to import first.");
      return;
    }
    setLoading(true);
    try {
      const result = await previewRosterImport(classId, csvText);
      if (result.error) {
        await notify.error("Could not read this file", result.error);
        return;
      }
      if (!result.rows || result.rows.length === 0) {
        await notify.warning("No rows found", "That file doesn't have any data rows to import.");
        return;
      }
      setPreview(result.rows);
      setStep("preview");
    } finally {
      setLoading(false);
    }
  }

  async function handleConfirm() {
    setLoading(true);
    try {
      const result = await commitRosterImport(classId, csvText);
      if (result.error) {
        await notify.error("Import failed", result.error);
        return;
      }
      setImported(result.imported ?? []);
      setStep("done");
      onImported(result.imported ?? []);
      await notify.success(
        "Import complete",
        `${result.imported?.length ?? 0} student(s) enrolled${result.skipped ? `, ${result.skipped} row(s) skipped` : ""}.`,
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleSendSms() {
    const recipients = imported
      .filter((row) => row.tempPassword)
      .map((row) => ({
        fullName: row.fullName,
        indexNumber: row.indexNumber,
        phone: preview.find((p) => p.indexNumber === row.indexNumber)?.phone ?? null,
        tempPassword: row.tempPassword!,
      }));

    if (recipients.length === 0) {
      await notify.info("Nothing to send", "No newly created accounts with a phone number in this batch.");
      return;
    }

    setLoading(true);
    try {
      const loginUrl = `${window.location.origin}/login`;
      const result = await sendLoginDetailsBySms(classId, loginUrl, recipients);
      if (result.error) {
        await notify.error("Could not send", result.error);
        return;
      }
      setSmsResults(result.results ?? []);
      await notify.toast({ title: "SMS send attempted — see results below" });
    } finally {
      setLoading(false);
    }
  }

  const validCount = preview.filter((r) => r.status === "valid").length;
  const problemCount = preview.length - validCount;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import students — {className}</DialogTitle>
          <DialogDescription>
            {step === "upload" && "Upload a CSV of students. Nothing is created until you confirm."}
            {step === "preview" && "Review the file below before anything is created."}
            {step === "done" && "Import complete."}
          </DialogDescription>
        </DialogHeader>

        {step === "upload" ? (
          <div className="space-y-4">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => downloadCsv("roster-template.csv", ROSTER_CSV_TEMPLATE)}
            >
              <FileDown aria-hidden />
              Download CSV template
            </Button>
            <p className="text-muted-foreground text-sm">
              Columns: <span className="font-mono">full_name, index_number, phone</span>. Index
              number must be exactly 10 digits. Phone is optional (used only for SMS).
            </p>
            <div className="space-y-2">
              <Label htmlFor="roster-file">CSV file</Label>
              <input
                ref={fileInputRef}
                id="roster-file"
                type="file"
                accept=".csv,text/csv"
                onChange={handleFileChange}
                className="border-input min-h-11 w-full rounded-lg border bg-transparent px-2.5 py-1.5 text-sm file:mr-3 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-secondary-foreground"
              />
              {fileName ? <p className="text-muted-foreground text-sm">Selected: {fileName}</p> : null}
            </div>
          </div>
        ) : null}

        {step === "preview" ? (
          <div className="space-y-4">
            <div
              role="status"
              className="bg-muted rounded-md p-3 text-sm"
            >
              <span className="font-medium">{validCount}</span> ready to import
              {problemCount > 0 ? (
                <>
                  , <span className="font-medium">{problemCount}</span> will be skipped (see reasons
                  below)
                </>
              ) : null}
              .
            </div>
            <div className="max-h-80 overflow-y-auto rounded-md border">
              <Table>
                <TableCaption className="sr-only">Import preview</TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">Row</TableHead>
                    <TableHead scope="col">Name</TableHead>
                    <TableHead scope="col">Index number</TableHead>
                    <TableHead scope="col">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {preview.map((row) => (
                    <TableRow key={row.rowNumber}>
                      <TableCell className="text-muted-foreground text-xs">{row.rowNumber}</TableCell>
                      <TableCell>{row.fullName || "—"}</TableCell>
                      <TableCell className="font-mono text-sm">{row.indexNumber || "—"}</TableCell>
                      <TableCell>
                        <span
                          className={
                            row.status === "valid"
                              ? "text-[oklch(0.4_0.13_155)] dark:text-[oklch(0.85_0.14_155)]"
                              : "text-muted-foreground"
                          }
                        >
                          {row.status !== "valid" ? (
                            <AlertCircle aria-hidden className="mr-1 inline size-3.5" />
                          ) : null}
                          {STATUS_LABEL[row.status]}
                          {row.message ? ` — ${row.message}` : ""}
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        ) : null}

        {step === "done" ? (
          <div className="space-y-4">
            <p className="text-sm">
              {imported.length} student(s) enrolled. Temp passwords below are shown{" "}
              <strong>once</strong> — export the roster from the class page or copy them now.
            </p>
            <div className="max-h-64 overflow-y-auto rounded-md border">
              <Table>
                <TableCaption className="sr-only">Import results</TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">Name</TableHead>
                    <TableHead scope="col">Index number</TableHead>
                    <TableHead scope="col">Temp password</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {imported.map((row) => (
                    <TableRow key={row.studentId}>
                      <TableCell>{row.fullName}</TableCell>
                      <TableCell className="font-mono text-sm">{row.indexNumber}</TableCell>
                      <TableCell className="font-mono text-sm">
                        {row.tempPassword ?? "(existing — use reset)"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <div className="space-y-2">
              <Button type="button" variant="outline" size="sm" onClick={handleSendSms} disabled={loading}>
                Send login details via SMS
              </Button>
              <p className="text-muted-foreground text-sm">
                Uses the configured SMS provider. Without live Hubtel credentials, this records what
                would be sent instead of sending it — see the results below.
              </p>
              {smsResults ? (
                <ul className="space-y-1 text-sm" aria-live="polite">
                  {smsResults.map((r) => (
                    <li key={r.indexNumber}>
                      <span className="font-medium">{r.fullName}</span> ({r.indexNumber}):{" "}
                      {r.ok ? "recorded/sent" : "not sent"} — {r.detail}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </div>
        ) : null}

        <DialogFooter>
          {step === "upload" ? (
            <Button type="button" onClick={handlePreview} disabled={loading}>
              <Upload aria-hidden />
              {loading ? "Reading…" : "Preview import"}
            </Button>
          ) : null}
          {step === "preview" ? (
            <>
              <Button type="button" variant="outline" onClick={() => setStep("upload")} disabled={loading}>
                Back
              </Button>
              <Button type="button" onClick={handleConfirm} disabled={loading || validCount === 0}>
                {loading ? "Importing…" : `Confirm import (${validCount})`}
              </Button>
            </>
          ) : null}
          {step === "done" ? (
            <Button type="button" onClick={() => handleOpenChange(false)}>
              Done
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
