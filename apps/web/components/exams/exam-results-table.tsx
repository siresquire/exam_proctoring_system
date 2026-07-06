import Link from "next/link";
import { FileWarning, PencilLine, ShieldAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ExamResultRow } from "@/lib/supabase/types";

const STATUS_VARIANT: Record<string, "secondary" | "destructive" | "outline" | "default"> = {
  in_progress: "outline",
  submitted: "secondary",
  auto_submitted: "secondary",
  terminated: "destructive",
  graded: "default",
};

const SESSION_STATUS_VARIANT: Record<string, "secondary" | "destructive" | "outline" | "default"> = {
  active: "default",
  ended: "secondary",
  abandoned: "outline",
  terminated: "destructive",
};

/**
 * Phase 3d-ii lecturer results table for a platform exam — reads
 * exam_results() (per-attempt grading state + integrity summary for
 * tier>=2 attempts). Deliberately thin, same posture as
 * FormsExamResultsTable: this is NOT the Phase 4 review workspace (no video
 * timeline, no per-flag verdicts) — just enough to see who needs grading
 * and whose attempt carries integrity concerns.
 */
export function ExamResultsTable({ examId, rows }: { examId: string; rows: ExamResultRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="text-muted-foreground text-sm" role="status">
        No students have started this exam yet.
      </p>
    );
  }

  return (
    <Table>
      <TableCaption className="sr-only">Results for every attempt at this exam</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>Student</TableHead>
          <TableHead>Index number</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Score</TableHead>
          <TableHead>Integrity</TableHead>
          <TableHead>Started</TableHead>
          <TableHead>
            <span className="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.attempt_id}>
            <TableCell className="font-medium">{row.full_name ?? "Unknown"}</TableCell>
            <TableCell className="font-mono text-xs">{row.student_number ?? "—"}</TableCell>
            <TableCell>
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant={STATUS_VARIANT[row.status] ?? "outline"}>{row.status.replace("_", " ")}</Badge>
                {row.needs_manual_grading ? (
                  <Badge variant="outline">
                    <PencilLine aria-hidden />
                    Needs grading
                  </Badge>
                ) : null}
              </div>
            </TableCell>
            <TableCell>
              {row.auto_score != null && row.max_score != null ? `${row.auto_score} / ${row.max_score}` : "—"}
            </TableCell>
            <TableCell>
              {row.proctor_session_id ? (
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge variant={SESSION_STATUS_VARIANT[row.session_status ?? ""] ?? "outline"}>
                    {row.session_status ?? "unknown"}
                  </Badge>
                  <span className="text-muted-foreground text-xs">
                    {row.violation_count ?? 0} / {row.violation_limit ?? 0}
                  </span>
                  {row.has_report ? (
                    <Badge variant="destructive">
                      <FileWarning aria-hidden />
                      Report
                    </Badge>
                  ) : null}
                </div>
              ) : (
                <span className="text-muted-foreground flex items-center gap-1 text-xs">
                  <ShieldAlert aria-hidden className="size-3.5" />
                  Not proctored (tier 1)
                </span>
              )}
            </TableCell>
            <TableCell className="text-muted-foreground text-xs">
              {new Date(row.started_at).toLocaleString()}
            </TableCell>
            <TableCell>
              {row.needs_manual_grading || row.status !== "in_progress" ? (
                <Button asChild variant="outline" size="sm">
                  <Link href={`/dashboard/lecturer/exams/${examId}/grade/${row.attempt_id}`}>
                    <PencilLine aria-hidden />
                    {row.needs_manual_grading ? "Grade" : "Review"}
                  </Link>
                </Button>
              ) : null}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
