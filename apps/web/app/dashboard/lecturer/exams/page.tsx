import Link from "next/link";
import { FileText, PlusCircle } from "lucide-react";

import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { ExamRow } from "@/lib/supabase/types";

const STATUS_BADGE_VARIANT: Record<string, "secondary" | "outline" | "destructive"> = {
  draft: "outline",
  published: "secondary",
  closed: "destructive",
};

/**
 * Phase 3c lecturer landing page for exams — mirrors classes/question-banks
 * list pages exactly (list + "new" link, same "any lecturer sees any exam"
 * known simplification documented on exams' RLS policy).
 */
export default async function ExamsPage() {
  await requireRole("lecturer", "admin");

  const supabase = await createClient();
  let exams: ExamRow[] = [];
  if (supabase) {
    const { data } = await supabase.from("exams").select("*").order("created_at", { ascending: false });
    exams = data ?? [];
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
      <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Exams</h1>
          <p className="text-muted-foreground mt-2 max-w-2xl">
            Build an exam from sections and question sources — fixed picks or randomized draws from
            a question bank — then assign a class, set the schedule and integrity tier, and publish.
          </p>
        </div>
        <Button asChild>
          <Link href="/dashboard/lecturer/exams/new">
            <PlusCircle aria-hidden />
            New exam
          </Link>
        </Button>
      </header>

      {exams.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">No exams yet</CardTitle>
            <CardDescription>Create one to start building sections.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline">
              <Link href="/dashboard/lecturer/exams/new">
                <PlusCircle aria-hidden />
                New exam
              </Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2">
          {exams.map((exam) => (
            <li key={exam.id}>
              <Link href={`/dashboard/lecturer/exams/${exam.id}`} className="block">
                <Card className="hover:bg-muted/50 transition-colors">
                  <CardHeader>
                    <div className="flex items-center justify-between gap-2">
                      <CardTitle className="flex items-center gap-2 text-base">
                        <FileText aria-hidden className="text-primary size-4" />
                        {exam.title}
                      </CardTitle>
                      <Badge variant={STATUS_BADGE_VARIANT[exam.status] ?? "outline"}>{exam.status}</Badge>
                    </div>
                    <CardDescription>{exam.description || "No description"}</CardDescription>
                  </CardHeader>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
