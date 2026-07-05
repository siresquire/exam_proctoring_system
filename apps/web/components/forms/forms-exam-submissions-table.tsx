import { CheckCircle2, HelpCircle, ShieldAlert, TimerOff } from "lucide-react";

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
import type { FormsExamSubmissionRow, FormsSubmissionMatchStatus } from "@/lib/supabase/types";

/**
 * Phase 2b: renders the Apps Script cross-check results (forms_submissions,
 * via the forms_exam_submissions RPC) — separate from
 * FormsExamResultsTable's proctoring sessions, since a submission and a
 * session are different things (a submission can exist with NO matching
 * session at all, which is exactly the bypass this feature detects).
 *
 * Never color alone (DESIGN.md/WCAG 2.2 AA): every status pairs an icon with
 * text, not just a badge color.
 */

const STATUS_META: Record<
  FormsSubmissionMatchStatus,
  { label: string; variant: "default" | "secondary" | "destructive" | "outline"; Icon: typeof CheckCircle2 }
> = {
  matched: { label: "Matched", variant: "secondary", Icon: CheckCircle2 },
  out_of_window: { label: "Submitted outside session", variant: "outline", Icon: TimerOff },
  no_session: { label: "No proctored session — possible bypass", variant: "destructive", Icon: ShieldAlert },
  no_email: { label: "No email on submission", variant: "outline", Icon: HelpCircle },
};

export function FormsExamSubmissionsTable({
  submissions,
}: {
  submissions: FormsExamSubmissionRow[];
}) {
  if (submissions.length === 0) {
    return (
      <p className="text-muted-foreground text-sm" role="status">
        No form submissions reported yet. Install the Apps Script cross-check above to start
        seeing them here.
      </p>
    );
  }

  return (
    <Table>
      <TableCaption className="sr-only">
        Google Form submissions reported by the Apps Script cross-check, with their match status
        against proctored sessions
      </TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>Respondent email</TableHead>
          <TableHead>Submitted</TableHead>
          <TableHead>Reported</TableHead>
          <TableHead>Match status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {submissions.map((submission) => {
          const meta = STATUS_META[submission.match_status];
          return (
            <TableRow key={submission.submission_id}>
              <TableCell className="font-mono text-xs">
                {submission.respondent_email ?? "—"}
              </TableCell>
              <TableCell className="text-muted-foreground text-xs">
                {submission.submitted_at ? new Date(submission.submitted_at).toLocaleString() : "—"}
              </TableCell>
              <TableCell className="text-muted-foreground text-xs">
                {new Date(submission.received_at).toLocaleString()}
              </TableCell>
              <TableCell>
                <Badge variant={meta.variant}>
                  <meta.Icon aria-hidden />
                  {meta.label}
                </Badge>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
