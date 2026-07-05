import Link from "next/link";
import { BookOpen, PlusCircle } from "lucide-react";

import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { QuestionBankRow } from "@/lib/supabase/types";

/**
 * Phase 3b lecturer landing page for question banks — mirrors
 * dashboard/lecturer/classes/page.tsx's structure exactly (list + "new"
 * link, same "any lecturer sees any bank" known simplification documented
 * on question_banks' RLS policy).
 */
export default async function QuestionBanksPage() {
  await requireRole("lecturer", "admin");

  const supabase = await createClient();
  let banks: QuestionBankRow[] = [];
  if (supabase) {
    const { data } = await supabase.from("question_banks").select("*").order("created_at", { ascending: false });
    banks = data ?? [];
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
      <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Question banks</h1>
          <p className="text-muted-foreground mt-2 max-w-2xl">
            Author versioned questions by type, organize them with categories and tags, and
            bulk-import from CSV, Aiken, or GIFT.
          </p>
        </div>
        <Button asChild>
          <Link href="/dashboard/lecturer/question-banks/new">
            <PlusCircle aria-hidden />
            New bank
          </Link>
        </Button>
      </header>

      {banks.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">No question banks yet</CardTitle>
            <CardDescription>Create one to start authoring questions.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline">
              <Link href="/dashboard/lecturer/question-banks/new">
                <PlusCircle aria-hidden />
                New bank
              </Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2">
          {banks.map((bank) => (
            <li key={bank.id}>
              <Link href={`/dashboard/lecturer/question-banks/${bank.id}`} className="block">
                <Card className="hover:bg-muted/50 transition-colors">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-base">
                      <BookOpen aria-hidden className="text-primary size-4" />
                      {bank.name}
                    </CardTitle>
                    <CardDescription>{bank.description || "No description"}</CardDescription>
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
