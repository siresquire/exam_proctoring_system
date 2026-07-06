import Link from "next/link";
import { FileText } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { ExamRow } from "@/lib/supabase/types";

/**
 * Student-facing "Upcoming exams" list (Phase 3c task brief, Start wired up
 * in Phase 3d-i). Rows already come pre-filtered by
 * exams_select_published_open_enrolled RLS (published + within
 * [opens_at, closes_at] + the student is a class_members row for
 * exams.class_id) — this component only renders what the server returned,
 * it does not re-check status/window/enrollment itself.
 *
 * "Start" links to /exam/[examId], which runs the attestation intro then
 * start_exam_attempt/get_attempt_questions (Phase 3d-i) — the RPCs
 * themselves re-derive enrollment/window/published-status independently, so
 * this link is not the security boundary, just navigation.
 */
export function UpcomingExamsList({ exams }: { exams: ExamRow[] }) {
  if (exams.length === 0) return null;

  return (
    <section aria-labelledby="upcoming-exams-heading" className="mb-8">
      <h2 id="upcoming-exams-heading" className="mb-4 text-lg font-semibold tracking-tight">
        Upcoming exams
      </h2>
      <div className="grid gap-4 sm:grid-cols-2">
        {exams.map((exam) => (
          <Card key={exam.id}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <FileText aria-hidden className="text-primary size-4" />
                {exam.title}
              </CardTitle>
              <CardDescription>
                {exam.description ? `${exam.description}. ` : ""}
                Tier T{exam.integrity_tier}
                {exam.duration_minutes ? `, ${exam.duration_minutes} minutes` : ""}.
                {exam.opens_at ? ` Opens ${new Date(exam.opens_at).toLocaleString()}.` : ""}
                {exam.closes_at ? ` Closes ${new Date(exam.closes_at).toLocaleString()}.` : ""}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              <Button asChild>
                <Link href={`/exam/${exam.id}`}>Start</Link>
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}
