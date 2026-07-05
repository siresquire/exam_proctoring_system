import Link from "next/link";
import { Users } from "lucide-react";

import { DashboardShell } from "@/components/dashboard-shell";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function AdminDashboard() {
  return (
    <div>
      <div className="mx-auto max-w-6xl px-4 pt-10 sm:px-6">
        <Link href="/dashboard/lecturer/classes" className="block">
          <Card className="hover:bg-muted/50 transition-colors">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Users aria-hidden className="text-primary" />
                Classes & enrollment
              </CardTitle>
              <CardDescription>
                Create classes, import students by CSV, and export a roster with login details.
              </CardDescription>
            </CardHeader>
          </Card>
        </Link>
      </div>
      <DashboardShell
        title="Admin Dashboard"
        description="Manage classes, lecturers, and department-level exam settings. Placeholder shell — wired up in later phases."
        cards={[
          { title: "Lecturers", description: "Assign lecturers to classes and question banks." },
          {
            title: "Exam windows",
            description: "Review scheduled exam windows across the department.",
          },
        ]}
      />
    </div>
  );
}
