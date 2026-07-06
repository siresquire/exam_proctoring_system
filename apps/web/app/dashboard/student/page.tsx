import { DashboardShell } from "@/components/dashboard-shell";
import { OpenFormsExamsList } from "@/components/forms/open-forms-exams-list";
import { UpcomingExamsList } from "@/components/exams/upcoming-exams-list";
import { createClient } from "@/lib/supabase/server";
import type { ExamRow, FormsExamRow } from "@/lib/supabase/types";

export default async function StudentDashboard() {
  const supabase = await createClient();
  let formsExams: FormsExamRow[] = [];
  let exams: ExamRow[] = [];
  if (supabase) {
    // RLS's forms_exams_select_published_and_open policy already restricts
    // this to status='published' AND within [opens_at, closes_at] — no
    // extra filtering needed here. Phase 3 note (task brief): without
    // enrollment/class scoping yet, this lists every published-and-open
    // Forms quiz platform-wide, not just the student's own classes.
    const [{ data: formsData }, { data: examsData }] = await Promise.all([
      supabase.from("forms_exams").select("*").order("created_at", { ascending: false }),
      // Phase 3c: exams_select_published_open_enrolled RLS restricts this to
      // status='published' AND within [opens_at, closes_at] AND the caller
      // is a class_members row for the exam's class_id — unlike forms_exams
      // above, this listing IS already class-enrollment-scoped.
      supabase.from("exams").select("*").order("opens_at", { ascending: true, nullsFirst: false }),
    ]);
    formsExams = formsData ?? [];
    exams = examsData ?? [];
  }

  return (
    <div>
      <div className="mx-auto max-w-6xl px-4 pt-10 sm:px-6">
        <UpcomingExamsList exams={exams} />
        <OpenFormsExamsList exams={formsExams} />
      </div>
      <DashboardShell
        title="Student Dashboard"
        description="Upcoming exams, past results, and appeals. Placeholder shell — wired up in later phases."
        cards={[
          { title: "Results", description: "Released grades and feedback." },
          { title: "Appeals", description: "Submit or track an appeal on a proctoring verdict." },
        ]}
      />
    </div>
  );
}
