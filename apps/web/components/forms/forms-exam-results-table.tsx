import { FileWarning } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { FormsExamSessionRow } from "@/lib/supabase/types";

const STATUS_VARIANT: Record<string, "secondary" | "destructive" | "outline" | "default"> = {
  active: "default",
  ended: "secondary",
  abandoned: "outline",
  terminated: "destructive",
};

/**
 * Lecturer results table for one forms_exam — reads forms_exam_sessions()
 * (see the Phase 2a migration). Deliberately thin: this links to "the
 * eventual review workflow" (Phase 4's per-flag verdict UI) rather than
 * reimplementing it here.
 */
export function FormsExamResultsTable({ sessions }: { sessions: FormsExamSessionRow[] }) {
  if (sessions.length === 0) {
    return (
      <p className="text-muted-foreground text-sm" role="status">
        No students have started this quiz yet.
      </p>
    );
  }

  return (
    <Table>
      <TableCaption className="sr-only">
        Proctoring results for every session started against this quiz
      </TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>Student</TableHead>
          <TableHead>Index number</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Strikes</TableHead>
          <TableHead>Started</TableHead>
          <TableHead>Ended</TableHead>
          <TableHead>Report</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sessions.map((session) => (
          <TableRow key={session.session_id}>
            <TableCell className="font-medium">{session.full_name ?? "Unknown"}</TableCell>
            <TableCell className="font-mono text-xs">
              {session.claimed_index_number ?? "—"}
            </TableCell>
            <TableCell>
              <Badge variant={STATUS_VARIANT[session.status] ?? "outline"}>{session.status}</Badge>
            </TableCell>
            <TableCell>
              {session.violation_count} / {session.violation_limit}
            </TableCell>
            <TableCell className="text-muted-foreground text-xs">
              {new Date(session.started_at).toLocaleString()}
            </TableCell>
            <TableCell className="text-muted-foreground text-xs">
              {session.ended_at ? new Date(session.ended_at).toLocaleString() : "In progress"}
            </TableCell>
            <TableCell>
              {session.has_report ? (
                <Badge variant="destructive">
                  <FileWarning aria-hidden />
                  Pending review
                </Badge>
              ) : (
                <span className="text-muted-foreground text-xs">None</span>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
