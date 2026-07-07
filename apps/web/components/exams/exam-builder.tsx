"use client";

import { useRouter } from "next/navigation";

import { addExamSection } from "@/app/dashboard/lecturer/exams/actions";
import { AddSectionButton, SectionEditor } from "@/components/exams/section-editor";
import { ExamPublishPanel } from "@/components/exams/exam-publish-panel";
import { ExamSettingsForm } from "@/components/exams/exam-settings-form";
import { Breadcrumbs } from "@/components/layout/breadcrumbs";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { notify } from "@/lib/notify";
import type {
  BankQuestionRow,
  ClassRow,
  ExamRow,
  ExamSectionRow,
  ExamSectionSourceRow,
  QuestionBankRow,
  QuestionCategoryRow,
} from "@/lib/supabase/types";

interface ExamBuilderProps {
  exam: ExamRow;
  sections: ExamSectionRow[];
  sources: ExamSectionSourceRow[];
  classes: ClassRow[];
  banks: QuestionBankRow[];
  questionsByBank: Record<string, BankQuestionRow[]>;
  categoriesByBank: Record<string, QuestionCategoryRow[]>;
}

const STATUS_BADGE_VARIANT: Record<string, "secondary" | "outline" | "destructive"> = {
  draft: "outline",
  published: "secondary",
  closed: "destructive",
};

/**
 * Phase 3c exam builder — the top-level client component for
 * /dashboard/lecturer/exams/[id]. Three tabs: Settings (exam-level
 * config), Sections (the section/source editor — the actual N-from-pool
 * anti-cheat draw configuration), Publish (validate/preview/publish, task
 * brief item 2). Kept as tabs rather than one long page because the
 * section editor alone can get long with several sections each carrying
 * their own add-source form.
 */
export function ExamBuilder({ exam, sections, sources, classes, banks, questionsByBank, categoriesByBank }: ExamBuilderProps) {
  const router = useRouter();

  async function handleAddSection(title: string, description: string) {
    const result = await addExamSection(exam.id, title, description);
    if (result.error) {
      await notify.error("Could not add section", result.error);
      return;
    }
    await notify.toast({ title: "Section added" });
    router.refresh();
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
      <Breadcrumbs
        items={[
          { label: "Dashboard", href: "/dashboard" },
          { label: "Exams", href: "/dashboard/lecturer/exams" },
          { label: exam.title },
        ]}
      />
      <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{exam.title}</h1>
            <Badge variant={STATUS_BADGE_VARIANT[exam.status] ?? "outline"}>{exam.status}</Badge>
          </div>
          <p className="text-muted-foreground mt-2 max-w-2xl">
            {exam.description || "Build sections and question sources, then validate and publish."}
          </p>
        </div>
      </header>

      <Tabs defaultValue="sections">
        <TabsList>
          <TabsTrigger value="settings">Settings</TabsTrigger>
          <TabsTrigger value="sections">Sections</TabsTrigger>
          <TabsTrigger value="publish">Publish</TabsTrigger>
        </TabsList>

        <TabsContent value="settings" className="mt-6">
          <ExamSettingsForm exam={exam} classes={classes} onSaved={() => router.refresh()} />
        </TabsContent>

        <TabsContent value="sections" className="mt-6 space-y-4">
          {sections.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No sections yet. Add one below — a section groups question sources (fixed picks and/or
              random draws from a pool) that are delivered together.
            </p>
          ) : (
            sections
              .slice()
              .sort((a, b) => a.ordinal - b.ordinal)
              .map((section, index) => (
                <SectionEditor
                  key={section.id}
                  examId={exam.id}
                  section={section}
                  sources={sources.filter((s) => s.section_id === section.id)}
                  isFirst={index === 0}
                  isLast={index === sections.length - 1}
                  banks={banks}
                  questionsByBank={questionsByBank}
                  categoriesByBank={categoriesByBank}
                />
              ))
          )}
          <AddSectionButton examId={exam.id} onAdd={handleAddSection} />
        </TabsContent>

        <TabsContent value="publish" className="mt-6">
          <ExamPublishPanel exam={exam} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
