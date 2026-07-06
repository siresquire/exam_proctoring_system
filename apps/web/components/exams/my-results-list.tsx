import Link from "next/link";
import { Award, FileText } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export interface MyAttemptSummary {
  attempt_id: string;
  exam_title: string;
  status: string;
  submitted_at: string | null;
}

const STATUS_LABEL: Record<string, string> = {
  in_progress: "In progress",
  submitted: "Submitted",
  auto_submitted: "Submitted (time expired)",
  terminated: "Ended — submitted for review",
  graded: "Graded",
};

/**
 * Phase 3d-ii student "My results" list: every attempt the student has
 * (any status past in_progress), each linking to /exam/[examId]/result,
 * which calls the release-gated get_attempt_result RPC. This list itself
 * shows no scores — only status — since the gating happens per-attempt on
 * the result page, not here.
 */
export function MyResultsList({ attempts }: { attempts: MyAttemptSummary[] }) {
  const finished = attempts.filter((a) => a.status !== "in_progress");

  if (finished.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Award aria-hidden className="text-primary size-4" />
            Results
          </CardTitle>
          <CardDescription>No submitted exams yet.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <section aria-labelledby="my-results-heading">
      <h2 id="my-results-heading" className="mb-4 text-lg font-semibold tracking-tight">
        My results
      </h2>
      <div className="grid gap-4 sm:grid-cols-2">
        {finished.map((attempt) => (
          <Card key={attempt.attempt_id}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <FileText aria-hidden className="text-primary size-4" />
                {attempt.exam_title}
              </CardTitle>
              <CardDescription className="flex items-center gap-2">
                <Badge variant={attempt.status === "terminated" ? "destructive" : "outline"}>
                  {STATUS_LABEL[attempt.status] ?? attempt.status}
                </Badge>
                {attempt.submitted_at ? new Date(attempt.submitted_at).toLocaleString() : null}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button asChild variant="outline">
                <Link href={`/exam/attempt/${attempt.attempt_id}/result`}>View result</Link>
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}
