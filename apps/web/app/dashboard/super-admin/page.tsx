import Link from "next/link";
import {
  Activity,
  BookOpen,
  FileClock,
  FileSpreadsheet,
  FileText,
  ShieldCheck,
  Users,
} from "lucide-react";

import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PlatformAnalyticsSection } from "@/components/admin/platform-analytics-section";
import { getPlatformAnalytics } from "@/lib/admin/platform-analytics";

const OVERSIGHT_CARDS = [
  {
    href: "/dashboard/users",
    icon: ShieldCheck,
    title: "Users & roles",
    description: "Manage every account's role and accommodations. Only you can grant admin or super admin.",
  },
  {
    href: "/dashboard/audit",
    icon: FileClock,
    title: "Audit log",
    description: "Browse every privileged action recorded on the platform. Read-only, append-only.",
  },
  {
    href: "/dashboard/system",
    icon: Activity,
    title: "System overview",
    description: "Live counts across users, classes, exams, and proctoring, plus keep-alive status.",
  },
];

const LECTURER_TOOL_CARDS = [
  {
    href: "/dashboard/lecturer/classes",
    icon: Users,
    title: "Classes & enrollment",
    description: "Create classes, import students by CSV, and export rosters.",
  },
  {
    href: "/dashboard/lecturer/question-banks",
    icon: BookOpen,
    title: "Question banks",
    description: "Author versioned questions and organize them into categories.",
  },
  {
    href: "/dashboard/lecturer/forms-exams",
    icon: FileSpreadsheet,
    title: "Google Forms quizzes",
    description: "Attach proctoring to an existing Google Form.",
  },
  {
    href: "/dashboard/lecturer/exams",
    icon: FileText,
    title: "Exams",
    description: "Build and schedule exams from question banks.",
  },
];

export default async function SuperAdminDashboard() {
  const analytics = await getPlatformAnalytics();

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Super admin dashboard</h1>
        <p className="text-muted-foreground mt-2 max-w-2xl">
          Platform-wide oversight: users, the audit trail, and system health. As a universal role,
          you can also reach every lecturer tool below.
        </p>
      </header>

      {analytics ? <PlatformAnalyticsSection analytics={analytics} /> : null}

      <section aria-labelledby="oversight-heading" className="mb-10">
        <h2 id="oversight-heading" className="mb-4 text-lg font-medium tracking-tight">
          Oversight
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {OVERSIGHT_CARDS.map(({ href, icon: Icon, title, description }) => (
            <Link key={href} href={href} className="block">
              <Card className="hover:bg-muted/50 h-full transition-colors">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Icon aria-hidden className="text-primary size-5" />
                    {title}
                  </CardTitle>
                  <CardDescription>{description}</CardDescription>
                </CardHeader>
              </Card>
            </Link>
          ))}
        </div>
      </section>

      <section aria-labelledby="lecturer-tools-heading">
        <h2 id="lecturer-tools-heading" className="mb-4 text-lg font-medium tracking-tight">
          Lecturer tools
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {LECTURER_TOOL_CARDS.map(({ href, icon: Icon, title, description }) => (
            <Link key={href} href={href} className="block">
              <Card className="hover:bg-muted/50 h-full transition-colors">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Icon aria-hidden className="text-primary size-5" />
                    {title}
                  </CardTitle>
                  <CardDescription>{description}</CardDescription>
                </CardHeader>
              </Card>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
