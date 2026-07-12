import Link from "next/link";
import { Suspense } from "react";
import { FileClock, ShieldCheck, Users } from "lucide-react";

import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PlatformAnalyticsSection } from "@/components/admin/platform-analytics-section";
import { AnalyticsSkeleton } from "@/components/charts/analytics-skeleton";
import { getPlatformAnalytics } from "@/lib/admin/platform-analytics";

const CARDS = [
  {
    href: "/dashboard/lecturer/classes",
    icon: Users,
    title: "Classes & enrollment",
    description: "Create classes, import students by CSV, and export a roster with login details.",
  },
  {
    href: "/dashboard/users",
    icon: ShieldCheck,
    title: "Users & roles",
    description:
      "Manage lecturer and student accounts, and edit accommodations. Role changes to admin or super admin require a super admin.",
  },
  {
    href: "/dashboard/audit",
    icon: FileClock,
    title: "Audit log",
    description: "Browse every privileged action recorded on the platform. Read-only.",
  },
];

/**
 * Isolated in its own async component so the Suspense boundary below can
 * stream it in separately — the service-role aggregate queries behind
 * getPlatformAnalytics (30-day activity, counts across users/exams/attempts/
 * sessions) are the slow part of this page; the header and nav cards must
 * not wait on them.
 */
async function PlatformAnalytics() {
  const analytics = await getPlatformAnalytics();
  return analytics ? <PlatformAnalyticsSection analytics={analytics} /> : null;
}

export default async function AdminDashboard() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Admin dashboard</h1>
        <p className="text-muted-foreground mt-2 max-w-2xl">
          Manage classes, lecturers, students, and review the audit trail.
        </p>
      </header>

      <Suspense fallback={<AnalyticsSkeleton className="mb-10" />}>
        <PlatformAnalytics />
      </Suspense>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {CARDS.map(({ href, icon: Icon, title, description }) => (
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
    </div>
  );
}
