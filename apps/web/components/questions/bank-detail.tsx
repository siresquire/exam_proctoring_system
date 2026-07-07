"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArchiveRestore, FileUp, Pencil, PlusCircle, Search } from "lucide-react";

import { setQuestionStatus } from "@/app/dashboard/lecturer/question-banks/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Breadcrumbs } from "@/components/layout/breadcrumbs";
import { CategoryTree } from "@/components/questions/category-tree";
import { notify } from "@/lib/notify";
import { QUESTION_TYPE_LABELS } from "@/lib/questions/types";
import type { BankQuestionRow, QuestionBankRow, QuestionCategoryRow } from "@/lib/supabase/types";

interface BankDetailProps {
  bank: QuestionBankRow;
  categories: QuestionCategoryRow[];
  questions: BankQuestionRow[];
}

const DIFFICULTY_LABELS: Record<string, string> = { easy: "Easy", medium: "Medium", hard: "Hard" };
const DIFFICULTY_BADGE_VARIANT: Record<string, "secondary" | "outline" | "destructive"> = {
  easy: "secondary",
  medium: "outline",
  hard: "destructive",
};

export function BankDetail({ bank, categories, questions }: BankDetailProps) {
  const router = useRouter();
  const [selectedCategoryId, setSelectedCategoryId] = React.useState<string | null>(null);
  const [typeFilter, setTypeFilter] = React.useState<string>("all");
  const [difficultyFilter, setDifficultyFilter] = React.useState<string>("all");
  const [statusFilter, setStatusFilter] = React.useState<string>("active");
  const [search, setSearch] = React.useState("");
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const filtered = React.useMemo(() => {
    return questions.filter((q) => {
      if (selectedCategoryId && q.category_id !== selectedCategoryId) return false;
      if (typeFilter !== "all" && q.type !== typeFilter) return false;
      if (difficultyFilter !== "all" && q.difficulty !== difficultyFilter) return false;
      if (statusFilter !== "all" && q.status !== statusFilter) return false;
      if (search.trim()) {
        const needle = search.trim().toLowerCase();
        const haystack = `${q.prompt ?? ""} ${(q.tags ?? []).join(" ")}`.toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    });
  }, [questions, selectedCategoryId, typeFilter, difficultyFilter, statusFilter, search]);

  async function handleToggleStatus(question: BankQuestionRow) {
    const nextStatus = question.status === "active" ? "retired" : "active";
    setBusyId(question.question_id);
    try {
      const result = await setQuestionStatus(bank.id, question.question_id, nextStatus);
      if (result.error) {
        await notify.error("Could not update status", result.error);
        return;
      }
      await notify.toast({ title: nextStatus === "retired" ? "Question retired" : "Question reactivated" });
      router.refresh();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <Breadcrumbs
        items={[
          { label: "Dashboard", href: "/dashboard" },
          { label: "Question banks", href: "/dashboard/lecturer/question-banks" },
          { label: bank.name },
        ]}
      />
      <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{bank.name}</h1>
          <p className="text-muted-foreground mt-2 max-w-2xl">{bank.description || "No description"}</p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="outline">
            <Link href={`/dashboard/lecturer/question-banks/${bank.id}/import`}>
              <FileUp aria-hidden />
              Bulk import
            </Link>
          </Button>
          <Button asChild>
            <Link href={`/dashboard/lecturer/question-banks/${bank.id}/questions/new`}>
              <PlusCircle aria-hidden />
              New question
            </Link>
          </Button>
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-[16rem_1fr]">
        <Card className="h-fit">
          <CardContent className="pt-6">
            <CategoryTree
              bankId={bank.id}
              categories={categories}
              selectedCategoryId={selectedCategoryId}
              onSelectCategory={setSelectedCategoryId}
            />
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Filters</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-4">
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="q-search">Search</Label>
                <div className="relative">
                  <Search aria-hidden className="text-muted-foreground absolute left-2.5 top-1/2 size-4 -translate-y-1/2" />
                  <Input
                    id="q-search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search prompt or tags"
                    className="min-h-11 pl-8"
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="filter-type">Type</Label>
                <select
                  id="filter-type"
                  value={typeFilter}
                  onChange={(e) => setTypeFilter(e.target.value)}
                  className="border-input h-9 w-full rounded-lg border bg-transparent px-2.5 py-1 text-sm dark:bg-input/30"
                >
                  <option value="all">All types</option>
                  {Object.entries(QUESTION_TYPE_LABELS).map(([type, label]) => (
                    <option key={type} value={type}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="filter-difficulty">Difficulty</Label>
                <select
                  id="filter-difficulty"
                  value={difficultyFilter}
                  onChange={(e) => setDifficultyFilter(e.target.value)}
                  className="border-input h-9 w-full rounded-lg border bg-transparent px-2.5 py-1 text-sm dark:bg-input/30"
                >
                  <option value="all">All difficulties</option>
                  <option value="easy">Easy</option>
                  <option value="medium">Medium</option>
                  <option value="hard">Hard</option>
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="filter-status">Status</Label>
                <select
                  id="filter-status"
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  className="border-input h-9 w-full rounded-lg border bg-transparent px-2.5 py-1 text-sm dark:bg-input/30"
                >
                  <option value="all">All statuses</option>
                  <option value="active">Active</option>
                  <option value="retired">Retired</option>
                </select>
              </div>
            </CardContent>
          </Card>

          <p className="text-muted-foreground text-sm" role="status">
            {filtered.length} of {questions.length} question{questions.length === 1 ? "" : "s"} shown.
          </p>

          {filtered.length === 0 ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">No questions match these filters</CardTitle>
                <CardDescription>Try clearing a filter, or add a new question.</CardDescription>
              </CardHeader>
            </Card>
          ) : (
            <ul className="space-y-3">
              {filtered.map((q) => (
                <li key={q.question_id}>
                  <Card>
                    <CardContent className="flex flex-wrap items-start justify-between gap-4 pt-6">
                      <div className="min-w-0 flex-1">
                        <div className="mb-2 flex flex-wrap items-center gap-2">
                          <Badge variant="outline">{QUESTION_TYPE_LABELS[q.type]}</Badge>
                          <Badge variant={DIFFICULTY_BADGE_VARIANT[q.difficulty] ?? "outline"}>
                            {DIFFICULTY_LABELS[q.difficulty] ?? q.difficulty}
                          </Badge>
                          {q.status === "retired" ? <Badge variant="destructive">Retired</Badge> : null}
                          {q.category_name ? <Badge variant="secondary">{q.category_name}</Badge> : null}
                          <span className="text-muted-foreground text-xs">v{q.version_no ?? 1}</span>
                        </div>
                        <p className="truncate text-sm font-medium">{q.prompt}</p>
                        {q.tags && q.tags.length > 0 ? (
                          <p className="text-muted-foreground mt-1 text-xs">Tags: {q.tags.join(", ")}</p>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 gap-2">
                        <Button asChild variant="outline" size="sm">
                          <Link href={`/dashboard/lecturer/question-banks/${bank.id}/questions/${q.question_id}/edit`}>
                            <Pencil aria-hidden className="size-4" />
                            Edit
                          </Link>
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => handleToggleStatus(q)}
                          disabled={busyId === q.question_id}
                        >
                          <ArchiveRestore aria-hidden className="size-4" />
                          {q.status === "active" ? "Retire" : "Reactivate"}
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
