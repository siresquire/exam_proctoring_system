import { DashboardShell } from "@/components/dashboard-shell";
import { OpenFormsExamsList } from "@/components/forms/open-forms-exams-list";
import { createClient } from "@/lib/supabase/server";
import type { FormsExamRow } from "@/lib/supabase/types";

export default async function StudentDashboard() {
  const supabase = await createClient();
  let exams: FormsExamRow[] = [];
  if (supabase) {
    // RLS's forms_exams_select_published_and_open policy already restricts
    // this to status='published' AND within [opens_at, closes_at] — no
    // extra filtering needed here. Phase 3 note (task brief): without
    // enrollment/class scoping yet, this lists every published-and-open
    // Forms quiz platform-wide, not just the student's own classes.
    const { data } = await supabase
      .from("forms_exams")
      .select("*")
      .order("created_at", { ascending: false });
    exams = data ?? [];
  }

  return (
    <div>
      <div className="mx-auto max-w-6xl px-4 pt-10 sm:px-6">
        <OpenFormsExamsList exams={exams} />
      </div>
      <DashboardShell
        title="Student Dashboard"
        description="Upcoming exams, past results, and appeals. Placeholder shell — wired up in later phases."
        cards={[
          { title: "Upcoming exams", description: "Exams scheduled for your enrolled classes." },
          { title: "Results", description: "Released grades and feedback." },
          { title: "Appeals", description: "Submit or track an appeal on a proctoring verdict." },
        ]}
      />
    </div>
  );
}
