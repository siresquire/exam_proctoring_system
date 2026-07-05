import Link from "next/link";
import { FileSpreadsheet } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { FormsExamRow } from "@/lib/supabase/types";

/**
 * Student-facing list of currently open Google Forms quizzes (Phase 2a).
 * The rows already come pre-filtered by forms_exams_select_published_and_open
 * RLS (see the page that renders this) — nothing here re-checks status or
 * the open window, it only renders what the server was willing to return.
 */
export function OpenFormsExamsList({ exams }: { exams: FormsExamRow[] }) {
  if (exams.length === 0) return null;

  return (
    <section aria-labelledby="open-forms-exams-heading" className="mb-8">
      <h2 id="open-forms-exams-heading" className="mb-4 text-lg font-semibold tracking-tight">
        Open Google Forms quizzes
      </h2>
      <div className="grid gap-4 sm:grid-cols-2">
        {exams.map((exam) => (
          <Card key={exam.id}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <FileSpreadsheet aria-hidden className="text-primary size-4" />
                {exam.title}
              </CardTitle>
              <CardDescription>
                Proctored, tier T{exam.integrity_tier}.
                {exam.closes_at
                  ? ` Closes ${new Date(exam.closes_at).toLocaleString()}.`
                  : " No closing time set."}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button asChild>
                <Link href={`/exam/forms/${exam.id}`}>Start</Link>
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}
