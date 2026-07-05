import Link from "next/link";
import { FileSpreadsheet } from "lucide-react";

import { DashboardShell } from "@/components/dashboard-shell";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function LecturerDashboard() {
  return (
    <div>
      <div className="mx-auto max-w-6xl px-4 pt-10 sm:px-6">
        <Link href="/dashboard/lecturer/forms-exams" className="block">
          <Card className="hover:bg-muted/50 transition-colors">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FileSpreadsheet aria-hidden className="text-primary" />
                Google Forms quizzes (System 1)
              </CardTitle>
              <CardDescription>
                Attach proctoring to an existing Google Form. Available now — no need to wait for
                the full exam platform below.
              </CardDescription>
            </CardHeader>
          </Card>
        </Link>
      </div>
      <DashboardShell
        title="Lecturer Dashboard"
        description="Build question banks, schedule exams, and review proctoring flags for your classes. Placeholder shell — wired up in later phases."
        cards={[
          { title: "Question banks", description: "Author and version exam questions." },
          { title: "Exams", description: "Schedule exams, set proctoring tier, review results." },
          {
            title: "Live monitoring",
            description: "Watch active exam sessions and respond to flags.",
          },
        ]}
      />
    </div>
  );
}
