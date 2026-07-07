"use client";

import * as React from "react";
import { ExternalLink, ShieldAlert, Wifi } from "lucide-react";

import { Breadcrumbs } from "@/components/layout/breadcrumbs";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { UserRole } from "@/lib/supabase/types";

export interface SystemCounts {
  usersByRole: Record<UserRole, number>;
  classesCount: number;
  banksCount: number;
  questionsCount: number;
  examsByStatus: Record<string, number>;
  attemptsByStatus: Record<string, number>;
  sessionsByStatus: Record<string, number>;
  pendingReportsCount: number;
  mediaCount: number;
}

interface SystemOverviewProps {
  counts: SystemCounts | null;
  keepalive: string | null;
  loadError?: string;
}

const ROLE_LABELS: Record<UserRole, string> = {
  super_admin: "Super admin",
  admin: "Admin",
  lecturer: "Lecturer",
  student: "Student",
};

function formatRelative(iso: string | null, nowMs: number): string {
  if (!iso) return "never";
  const diffMs = nowMs - new Date(iso).getTime();
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function StatRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono font-medium">{value >= 0 ? value : "—"}</span>
    </div>
  );
}

export function SystemOverview({ counts, keepalive, loadError }: SystemOverviewProps) {
  // Date.now() is impure and React's purity rule disallows calling it
  // during render (see exam-room.tsx's identical convention). Rather than
  // one setState-in-effect call (flagged by react-hooks/set-state-in-effect
  // as a synchronous cascading render), this subscribes to a 30s interval —
  // a genuine external clock — which also keeps "X minutes ago" fresh for
  // anyone leaving this page open.
  const [nowMs, setNowMs] = React.useState<number | null>(null);
  React.useEffect(() => {
    const tick = () => setNowMs(Date.now());
    const id = setInterval(tick, 30_000);
    tick();
    return () => clearInterval(id);
  }, []);

  const staleKeepalive =
    nowMs !== null && keepalive ? nowMs - new Date(keepalive).getTime() > 1000 * 60 * 60 * 24 * 6 : false;

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <Breadcrumbs items={[{ label: "Dashboard", href: "/dashboard" }, { label: "System overview" }]} />
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">System overview</h1>
        <p className="text-muted-foreground mt-2 max-w-2xl">
          Live row counts computed directly from the database. Storage and quota usage is not
          computable from here — see the provider console links below.
        </p>
      </header>

      {loadError ? (
        <Card className="border-destructive mb-6">
          <CardHeader>
            <CardTitle className="text-destructive flex items-center gap-2 text-base">
              <ShieldAlert aria-hidden className="size-4" />
              Could not load system counts
            </CardTitle>
            <CardDescription>{loadError}</CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      {counts ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Users by role</CardTitle>
            </CardHeader>
            <CardContent>
              {(Object.keys(ROLE_LABELS) as UserRole[]).map((role) => (
                <StatRow key={role} label={ROLE_LABELS[role]} value={counts.usersByRole[role] ?? 0} />
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Classes & content</CardTitle>
            </CardHeader>
            <CardContent>
              <StatRow label="Classes" value={counts.classesCount} />
              <StatRow label="Question banks" value={counts.banksCount} />
              <StatRow label="Questions" value={counts.questionsCount} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Exams by status</CardTitle>
            </CardHeader>
            <CardContent>
              {Object.entries(counts.examsByStatus).map(([status, value]) => (
                <StatRow key={status} label={status} value={value} />
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Exam attempts by status</CardTitle>
            </CardHeader>
            <CardContent>
              {Object.entries(counts.attemptsByStatus).map(([status, value]) => (
                <StatRow key={status} label={status.replace(/_/g, " ")} value={value} />
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Proctoring sessions by status</CardTitle>
            </CardHeader>
            <CardContent>
              {Object.entries(counts.sessionsByStatus).map(([status, value]) => (
                <StatRow key={status} label={status} value={value} />
              ))}
              <StatRow label="Reports pending review" value={counts.pendingReportsCount} />
              <StatRow label="Proctoring media files" value={counts.mediaCount} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Wifi aria-hidden className="size-4" />
                Keep-alive
              </CardTitle>
              <CardDescription>Cron ping that keeps the free-tier project out of idle pause.</CardDescription>
            </CardHeader>
            <CardContent>
              <p className={`text-sm ${staleKeepalive ? "text-destructive font-medium" : ""}`} role="status">
                Last ping: {nowMs === null ? "…" : formatRelative(keepalive, nowMs)}
                {staleKeepalive ? " — overdue, check the GitHub Actions cron" : ""}
              </p>
            </CardContent>
          </Card>
        </div>
      ) : null}

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">Storage & quota</CardTitle>
          <CardDescription>
            Supabase and Cloudflare R2 free-tier usage (database size, storage, bandwidth) requires
            each provider&apos;s management API, which is not wired into this app. These figures are
            checked in the provider console — no numbers are fabricated here.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-4">
          <a
            href="https://supabase.com/dashboard/project/_/settings/billing/subscription"
            target="_blank"
            rel="noreferrer"
            className="text-primary inline-flex min-h-11 items-center gap-1.5 text-sm font-medium underline-offset-4 hover:underline"
          >
            Supabase project usage
            <ExternalLink aria-hidden className="size-3.5" />
          </a>
          <a
            href="https://dash.cloudflare.com/?to=/:account/r2/overview"
            target="_blank"
            rel="noreferrer"
            className="text-primary inline-flex min-h-11 items-center gap-1.5 text-sm font-medium underline-offset-4 hover:underline"
          >
            Cloudflare R2 usage
            <ExternalLink aria-hidden className="size-3.5" />
          </a>
        </CardContent>
      </Card>
    </div>
  );
}
