import Link from "next/link";
import { PlusCircle } from "lucide-react";

import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FormsExamList } from "@/components/forms/forms-exam-list";
import { Breadcrumbs } from "@/components/layout/breadcrumbs";
import type { FormsExamRow } from "@/lib/supabase/types";

/**
 * Phase 2a lecturer landing page for System 1 (the proctored Google Forms
 * wrapper): lists the lecturer's own forms-exams (RLS's
 * forms_exams_select_owner_or_lecturer policy — "any lecturer" for now, same
 * known simplification as proctor_* everywhere else in this codebase; Phase
 * 3/4 scopes this to ownership/class) with a link to create a new one.
 */
export default async function FormsExamsPage() {
  await requireRole("lecturer", "admin");

  const supabase = await createClient();
  let exams: FormsExamRow[] = [];
  if (supabase) {
    const { data } = await supabase
      .from("forms_exams")
      .select("*")
      .order("created_at", { ascending: false });
    exams = data ?? [];
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
      <Breadcrumbs
        items={[{ label: "Dashboard", href: "/dashboard" }, { label: "Google Forms quizzes" }]}
      />
      <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Google Forms quizzes</h1>
          <p className="text-muted-foreground mt-2 max-w-2xl">
            Attach proctoring to an ordinary Google Form. Students take the form inside a monitored
            wrapper page — we watch the exam environment (tab switches, camera, fullscreen,
            clipboard), never the form&apos;s questions or answers, which stay entirely on Google.
          </p>
        </div>
        <Button asChild>
          <Link href="/dashboard/lecturer/forms-exams/new">
            <PlusCircle aria-hidden />
            New Forms quiz
          </Link>
        </Button>
      </header>

      {exams.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">No Forms quizzes yet</CardTitle>
            <CardDescription>
              Create one to get a student link you can share once it&apos;s published.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline">
              <Link href="/dashboard/lecturer/forms-exams/new">
                <PlusCircle aria-hidden />
                New Forms quiz
              </Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <FormsExamList exams={exams} />
      )}
    </div>
  );
}
