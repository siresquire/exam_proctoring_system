"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Download, RefreshCw, Trash2, UserPlus } from "lucide-react";

import { regenerateStudentPassword, removeStudentFromClass } from "@/app/dashboard/lecturer/classes/actions";
import { RosterImportDialog } from "@/components/onboarding/roster-import-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { buildRosterCsv, downloadCsv, type RosterExportRow } from "@/lib/onboarding/roster-export";
import type { ClassRosterRow, ClassRow } from "@/lib/supabase/types";

interface ClassDetailProps {
  klass: ClassRow;
  roster: ClassRosterRow[];
}

/**
 * Phase 3a class detail page: roster table, CSV import entry point, and
 * per-row "regenerate password" (for re-distribution when a student loses
 * their temp password). Freshly generated/regenerated passwords are held
 * ONLY in component state (never persisted, never re-fetchable) — see
 * lib/onboarding/create-student.ts's doc comment on why the temp password
 * can only ever be shown once.
 */
export function ClassDetail({ klass, roster }: ClassDetailProps) {
  const router = useRouter();
  const [importOpen, setImportOpen] = React.useState(false);
  // studentId -> freshly generated password, shown once until the next
  // page refresh/navigation clears this state.
  const [freshPasswords, setFreshPasswords] = React.useState<Record<string, string>>({});
  const [busyId, setBusyId] = React.useState<string | null>(null);

  async function handleRegenerate(studentId: string, fullName: string | null) {
    const confirmed = await notify.confirm({
      title: "Regenerate password?",
      text: `${fullName ?? "This student"}'s current password stops working immediately. They will need the new one to sign in, and will be asked to set their own password again.`,
      confirmButtonText: "Regenerate",
    });
    if (!confirmed) return;

    setBusyId(studentId);
    try {
      const result = await regenerateStudentPassword(studentId);
      if (result.error) {
        await notify.error("Could not regenerate password", result.error);
        return;
      }
      setFreshPasswords((prev) => ({ ...prev, [studentId]: result.tempPassword! }));
      await notify.success("Password regenerated", "Shown once below — copy it before leaving this page.");
    } finally {
      setBusyId(null);
    }
  }

  async function handleRemove(studentId: string, fullName: string | null) {
    const confirmed = await notify.confirm({
      title: "Remove from class?",
      text: `${fullName ?? "This student"} will no longer appear on this class's roster. Their account is not deleted.`,
      confirmButtonText: "Remove",
      destructive: true,
    });
    if (!confirmed) return;

    setBusyId(studentId);
    try {
      const result = await removeStudentFromClass(klass.id, studentId);
      if (result.error) {
        await notify.error("Could not remove student", result.error);
        return;
      }
      await notify.toast({ title: "Removed from class" });
      router.refresh();
    } finally {
      setBusyId(null);
    }
  }

  function handleExportRoster() {
    const loginUrl = `${window.location.origin}/login`;
    const rows: RosterExportRow[] = roster.map((r) => ({
      fullName: r.full_name ?? "(no name on file)",
      indexNumber: r.student_number ?? "",
      loginUrl,
      tempPassword: freshPasswords[r.student_id] ?? null,
    }));
    downloadCsv(`${klass.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-roster.csv`, buildRosterCsv(rows));
    void notify.toast({ title: "Roster CSV downloaded" });
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
      <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{klass.name}</h1>
          <p className="text-muted-foreground mt-2 max-w-2xl">
            {klass.code ? `Code: ${klass.code}` : "No class code"}
            {klass.description ? ` — ${klass.description}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={handleExportRoster} disabled={roster.length === 0}>
            <Download aria-hidden />
            Export roster (CSV)
          </Button>
          <Button onClick={() => setImportOpen(true)}>
            <UserPlus aria-hidden />
            Import students (CSV)
          </Button>
        </div>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Roster</CardTitle>
          <CardDescription>
            {roster.length} student{roster.length === 1 ? "" : "s"} enrolled.
            {Object.keys(freshPasswords).length > 0
              ? " Temp passwords below are shown once — export the roster or copy them now."
              : ""}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {roster.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No students yet. Use &quot;Import students (CSV)&quot; to add some.
            </p>
          ) : (
            <Table>
              <TableCaption className="sr-only">Class roster for {klass.name}</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Name</TableHead>
                  <TableHead scope="col">Index number</TableHead>
                  <TableHead scope="col">Phone</TableHead>
                  <TableHead scope="col">Temp password</TableHead>
                  <TableHead scope="col" className="text-right">
                    Actions
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {roster.map((student) => (
                  <TableRow key={student.student_id}>
                    <TableCell className="font-medium">{student.full_name ?? "—"}</TableCell>
                    <TableCell className="font-mono text-sm">{student.student_number ?? "—"}</TableCell>
                    <TableCell className="text-muted-foreground text-sm">{student.phone ?? "—"}</TableCell>
                    <TableCell>
                      {freshPasswords[student.student_id] ? (
                        <Badge variant="secondary" className="font-mono">
                          {freshPasswords[student.student_id]}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground text-sm">(existing — use reset)</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap justify-end gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busyId === student.student_id}
                          onClick={() => handleRegenerate(student.student_id, student.full_name)}
                        >
                          <RefreshCw aria-hidden />
                          Reset password
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busyId === student.student_id}
                          onClick={() => handleRemove(student.student_id, student.full_name)}
                        >
                          <Trash2 aria-hidden />
                          Remove
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <RosterImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        classId={klass.id}
        className={klass.name}
        onImported={(imported) => {
          setFreshPasswords((prev) => {
            const next = { ...prev };
            for (const row of imported) {
              if (row.tempPassword) next[row.studentId] = row.tempPassword;
            }
            return next;
          });
          router.refresh();
        }}
      />
    </div>
  );
}
