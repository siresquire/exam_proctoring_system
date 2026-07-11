"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Download,
  MoreHorizontal,
  RefreshCw,
  ShieldCheck,
  ShieldOff,
  Trash2,
  UserPlus,
  UserX,
} from "lucide-react";

import { setAccountStatus } from "@/app/dashboard/users/actions";
import { regenerateStudentPassword, removeStudentFromClass } from "@/app/dashboard/lecturer/classes/actions";
import { Breadcrumbs } from "@/components/layout/breadcrumbs";
import { AddStudentDialog } from "@/components/onboarding/add-student-dialog";
import { RosterImportDialog } from "@/components/onboarding/roster-import-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import type { ClassRosterRow, ClassRow, ProfileStatus } from "@/lib/supabase/types";

interface ClassDetailProps {
  klass: ClassRow;
  roster: ClassRosterRow[];
  /**
   * Phase 4: whether the current viewer may act on this roster's student
   * accounts (suspend/reactivate/remove) — true for admin/super_admin
   * always, true for a lecturer only when they OWN this class. Computed
   * server-side in page.tsx from `classes.owner_id`; `set_account_status`
   * re-checks ownership independently regardless, so this only controls
   * whether the (would-fail) buttons are rendered at all.
   */
  canManageAccounts: boolean;
}

/**
 * Account-lifecycle status badge — same rendering as
 * components/admin/users-table.tsx's AccountStatusBadge (icon + text, never
 * color alone per DESIGN.md §1). Kept local to avoid a cross-directory
 * import between the admin and onboarding component trees for one small
 * shared visual; the underlying data/semantics are identical.
 */
function AccountStatusBadge({ status }: { status: ProfileStatus }) {
  if (status === "suspended") {
    return (
      <Badge variant="secondary">
        <ShieldOff aria-hidden className="size-3.5" />
        Suspended
      </Badge>
    );
  }
  if (status === "removed") {
    return (
      <Badge variant="destructive">
        <UserX aria-hidden className="size-3.5" />
        Removed
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-success border-success/40">
      <ShieldCheck aria-hidden className="size-3.5" />
      Active
    </Badge>
  );
}

/**
 * Phase 3a class detail page: roster table, CSV import entry point, and
 * per-row "regenerate password" (for re-distribution when a student loses
 * their temp password). Freshly generated/regenerated passwords are held
 * ONLY in component state (never persisted, never re-fetchable) — see
 * lib/onboarding/create-student.ts's doc comment on why the temp password
 * can only ever be shown once.
 */
export function ClassDetail({ klass, roster, canManageAccounts }: ClassDetailProps) {
  const router = useRouter();
  const [importOpen, setImportOpen] = React.useState(false);
  const [addOpen, setAddOpen] = React.useState(false);
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

  /**
   * Account-lifecycle action (suspend/reactivate/remove the STUDENT'S
   * ACCOUNT) — distinct from handleRemove above, which only unenrolls them
   * from this one class and never touches the account itself. Wired to the
   * same set_account_status RPC the Users & roles table uses; the RPC
   * re-checks that this lecturer OWNS this class before allowing it.
   */
  async function handleSetAccountStatus(studentId: string, fullName: string | null, newStatus: "active" | "suspended" | "removed") {
    const name = fullName ?? "This student";
    const verb = newStatus === "active" ? "Reactivate" : newStatus === "suspended" ? "Suspend" : "Remove";
    const text =
      newStatus === "active"
        ? `${name} regains normal access immediately and can sign in again.`
        : newStatus === "suspended"
          ? `${name}'s account is blocked from signing in until reactivated. This is reversible and does not affect their enrollment here.`
          : `${name}'s account is archived: blocked from signing in, but their records are kept. Reversible by reactivating later. Their class enrollment is unaffected.`;

    const confirmed = await notify.confirm({
      title: `${verb} ${name}'s account?`,
      text,
      confirmButtonText: verb,
      destructive: newStatus !== "active",
    });
    if (!confirmed) return;

    setBusyId(studentId);
    try {
      const result = await setAccountStatus(studentId, newStatus);
      if (result.error) {
        await notify.error(`Could not ${verb.toLowerCase()} account`, result.error);
        return;
      }
      await notify.toast({
        title: newStatus === "active" ? "Account reactivated" : newStatus === "suspended" ? "Account suspended" : "Account removed",
      });
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
      <Breadcrumbs
        items={[
          { label: "Dashboard", href: "/dashboard" },
          { label: "Classes", href: "/dashboard/lecturer/classes" },
          { label: klass.name },
        ]}
      />
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
          <Button variant="outline" onClick={() => setAddOpen(true)}>
            <UserPlus aria-hidden />
            Add student
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
              No students yet. Use &quot;Add student&quot; for one at a time, or &quot;Import students
              (CSV)&quot; for a roster.
            </p>
          ) : (
            <Table>
              <TableCaption className="sr-only">Class roster for {klass.name}</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Name</TableHead>
                  <TableHead scope="col">Index number</TableHead>
                  <TableHead scope="col">Phone</TableHead>
                  <TableHead scope="col">Status</TableHead>
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
                      <AccountStatusBadge status={student.status} />
                    </TableCell>
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
                          Remove from class
                        </Button>
                        {canManageAccounts ? (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={busyId === student.student_id}
                                aria-label={`Account actions for ${student.full_name ?? "student"}`}
                              >
                                <MoreHorizontal aria-hidden />
                                Account
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              {student.status !== "active" ? (
                                <DropdownMenuItem
                                  onSelect={() => handleSetAccountStatus(student.student_id, student.full_name, "active")}
                                >
                                  <ShieldCheck aria-hidden />
                                  Reactivate account
                                </DropdownMenuItem>
                              ) : null}
                              {student.status === "active" ? (
                                <DropdownMenuItem
                                  onSelect={() => handleSetAccountStatus(student.student_id, student.full_name, "suspended")}
                                >
                                  <ShieldOff aria-hidden />
                                  Suspend account
                                </DropdownMenuItem>
                              ) : null}
                              {student.status !== "removed" ? (
                                <DropdownMenuItem
                                  variant="destructive"
                                  onSelect={() => handleSetAccountStatus(student.student_id, student.full_name, "removed")}
                                >
                                  <UserX aria-hidden />
                                  Remove account (soft delete)
                                </DropdownMenuItem>
                              ) : null}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        ) : null}
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

      <AddStudentDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        classId={klass.id}
        className={klass.name}
        onAdded={({ studentId, tempPassword }) => {
          if (tempPassword) {
            setFreshPasswords((prev) => ({ ...prev, [studentId]: tempPassword }));
          }
          router.refresh();
        }}
      />
    </div>
  );
}
