import Link from "next/link";
import { Suspense } from "react";
import { BookOpen, FileSpreadsheet, FileText, Users } from "lucide-react";

import { DashboardShell } from "@/components/dashboard-shell";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { LecturerAnalyticsSection } from "@/components/lecturer/lecturer-analytics-section";
import { AnalyticsSkeleton } from "@/components/charts/analytics-skeleton";
import { createClient } from "@/lib/supabase/server";
import type { LecturerDashboardStats } from "@/lib/supabase/types";

/**
 * Isolated in its own async component (own Supabase client, own query) so
 * the Suspense boundary below can stream it in separately — the
 * lecturer_dashboard_stats() RPC aggregates across every one of the
 * lecturer's exams/attempts/flags and is the slow part of this page; the
 * nav cards below must not wait on it.
 */
async function LecturerAnalytics() {
  const supabase = await createClient();
  let stats: LecturerDashboardStats | null = null;
  if (supabase) {
    const { data } = await supabase.rpc("lecturer_dashboard_stats");
    stats = (data as LecturerDashboardStats | null) ?? null;
  }
  return stats ? <LecturerAnalyticsSection stats={stats} /> : null;
}

export default async function LecturerDashboard() {
  return (
    <div>
      <Suspense fallback={<AnalyticsSkeleton className="mx-auto max-w-6xl px-4 pt-10 sm:px-6" />}>
        <LecturerAnalytics />
      </Suspense>
      <div className="mx-auto grid max-w-6xl gap-4 px-4 pt-6 first:pt-10 sm:grid-cols-2 sm:px-6 lg:grid-cols-3">
        <Link href="/dashboard/lecturer/classes" className="block">
          <Card className="hover:bg-muted/50 h-full transition-colors">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Users aria-hidden className="text-primary" />
                Classes & enrollment
              </CardTitle>
              <CardDescription>
                Create classes, import students by CSV, and export a roster with login details —
                no student email address required.
              </CardDescription>
            </CardHeader>
          </Card>
        </Link>
        <Link href="/dashboard/lecturer/question-banks" className="block">
          <Card className="hover:bg-muted/50 h-full transition-colors">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <BookOpen aria-hidden className="text-primary" />
                Question banks
              </CardTitle>
              <CardDescription>
                Author versioned questions by type, organize them into categories, and bulk-import
                from CSV, Aiken, or GIFT.
              </CardDescription>
            </CardHeader>
          </Card>
        </Link>
        <Link href="/dashboard/lecturer/forms-exams" className="block">
          <Card className="hover:bg-muted/50 h-full transition-colors">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FileSpreadsheet aria-hidden className="text-primary" />
                Google Forms quizzes
              </CardTitle>
              <CardDescription>
                Attach proctoring to an existing Google Form. Available now — no need to wait for
                the full exam platform below.
              </CardDescription>
            </CardHeader>
          </Card>
        </Link>
        <Link href="/dashboard/lecturer/exams" className="block">
          <Card className="hover:bg-muted/50 h-full transition-colors">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FileText aria-hidden className="text-primary" />
                Exams
              </CardTitle>
              <CardDescription>
                Build exams from sections and question banks — fixed picks or randomized N-from-pool
                draws, per-student shuffling, scheduling, and integrity tier.
              </CardDescription>
            </CardHeader>
          </Card>
        </Link>
      </div>
      <DashboardShell
        title="Lecturer Dashboard"
        description="Schedule exams and review proctoring flags for your classes."
        cards={[
          {
            title: "Live monitoring",
            description: "Watch active exam sessions and respond to flags. Coming soon.",
          },
        ]}
      />
    </div>
  );
}
