"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronDown, ChevronLeft, ChevronRight, Lock, ShieldAlert } from "lucide-react";

import { Breadcrumbs } from "@/components/layout/breadcrumbs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { Database } from "@/lib/supabase/types";

type AuditLogRow = Database["public"]["Tables"]["audit_log"]["Row"];

interface ActorInfo {
  fullName: string | null;
  email: string | null;
}

interface AuditLogBrowserProps {
  entries: AuditLogRow[];
  actors: Record<string, ActorInfo>;
  distinctActions: string[];
  page: number;
  pageCount: number;
  totalCount: number;
  actionFilter: string | null;
  loadError?: string;
}

function formatActor(actorId: string | null, actors: Record<string, ActorInfo>): string {
  if (!actorId) return "System";
  const info = actors[actorId];
  if (!info) return actorId;
  return info.fullName ?? info.email ?? actorId;
}

export function AuditLogBrowser({
  entries,
  actors,
  distinctActions,
  page,
  pageCount,
  totalCount,
  actionFilter,
  loadError,
}: AuditLogBrowserProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [expandedId, setExpandedId] = React.useState<number | null>(null);

  function buildHref(overrides: { page?: number; action?: string | null }) {
    const next = new URLSearchParams(searchParams.toString());
    if (overrides.page !== undefined) next.set("page", String(overrides.page));
    if (overrides.action !== undefined) {
      if (overrides.action) next.set("action", overrides.action);
      else next.delete("action");
    }
    return `/dashboard/audit?${next.toString()}`;
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <Breadcrumbs items={[{ label: "Dashboard", href: "/dashboard" }, { label: "Audit log" }]} />
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Audit log</h1>
        <p className="text-muted-foreground mt-2 flex max-w-2xl items-start gap-2">
          <Lock aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>
            Read-only and append-only: every privileged action across the platform writes here and
            cannot be edited or deleted, including by a super admin.
          </span>
        </p>
      </header>

      {loadError ? (
        <Card className="border-destructive mb-6">
          <CardHeader>
            <CardTitle className="text-destructive flex items-center gap-2 text-base">
              <ShieldAlert aria-hidden className="size-4" />
              Could not load the audit log
            </CardTitle>
            <CardDescription>{loadError}</CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Entries</CardTitle>
          <CardDescription>
            {totalCount} entr{totalCount === 1 ? "y" : "ies"} total. Showing page {page} of {pageCount}.
          </CardDescription>
          <div className="max-w-xs space-y-2 pt-2">
            <Label htmlFor="action-filter">Filter by action</Label>
            <select
              id="action-filter"
              value={actionFilter ?? "all"}
              onChange={(e) => router.push(buildHref({ page: 1, action: e.target.value === "all" ? null : e.target.value }))}
              className="border-input h-11 w-full rounded-lg border bg-transparent px-2.5 py-1 text-sm dark:bg-input/30"
            >
              <option value="all">All actions</option>
              {distinctActions.map((action) => (
                <option key={action} value={action}>
                  {action}
                </option>
              ))}
            </select>
          </div>
        </CardHeader>
        <CardContent>
          {entries.length === 0 ? (
            <p className="text-muted-foreground text-sm">No audit log entries match this filter.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableCaption className="sr-only">Audit log entries, newest first</TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">Time</TableHead>
                    <TableHead scope="col">Actor</TableHead>
                    <TableHead scope="col">Action</TableHead>
                    <TableHead scope="col">Target</TableHead>
                    <TableHead scope="col">IP</TableHead>
                    <TableHead scope="col" className="text-right">
                      Details
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {entries.map((entry) => {
                    const isExpanded = expandedId === entry.id;
                    return (
                      <React.Fragment key={entry.id}>
                        <TableRow>
                          <TableCell className="text-muted-foreground whitespace-nowrap text-sm">
                            {new Date(entry.created_at).toLocaleString()}
                          </TableCell>
                          <TableCell className="text-sm">{formatActor(entry.actor_id, actors)}</TableCell>
                          <TableCell>
                            <Badge variant="outline" className="font-mono">
                              {entry.action}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-muted-foreground text-sm">
                            {entry.target_type ? `${entry.target_type}: ${entry.target_id ?? "—"}` : "—"}
                          </TableCell>
                          <TableCell className="text-muted-foreground font-mono text-xs">
                            {entry.ip ?? "—"}
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              variant="ghost"
                              size="sm"
                              aria-expanded={isExpanded}
                              aria-controls={`audit-metadata-${entry.id}`}
                              onClick={() => setExpandedId(isExpanded ? null : entry.id)}
                            >
                              <ChevronDown
                                aria-hidden
                                className={`size-4 transition-transform ${isExpanded ? "rotate-180" : ""}`}
                              />
                              {isExpanded ? "Hide" : "Show"}
                            </Button>
                          </TableCell>
                        </TableRow>
                        {isExpanded ? (
                          <TableRow>
                            <TableCell colSpan={6} className="bg-muted/30">
                              <pre
                                id={`audit-metadata-${entry.id}`}
                                className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs"
                              >
                                {JSON.stringify(entry.metadata, null, 2)}
                              </pre>
                            </TableCell>
                          </TableRow>
                        ) : null}
                      </React.Fragment>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}

          <nav aria-label="Audit log pages" className="mt-6 flex items-center justify-between gap-4">
            <Button variant="outline" size="sm" asChild disabled={page <= 1}>
              {page <= 1 ? (
                <span>
                  <ChevronLeft aria-hidden className="size-4" />
                  Previous
                </span>
              ) : (
                <Link href={buildHref({ page: page - 1 })}>
                  <ChevronLeft aria-hidden className="size-4" />
                  Previous
                </Link>
              )}
            </Button>
            <span className="text-muted-foreground text-sm" aria-live="polite">
              Page {page} of {pageCount}
            </span>
            <Button variant="outline" size="sm" asChild disabled={page >= pageCount}>
              {page >= pageCount ? (
                <span>
                  Next
                  <ChevronRight aria-hidden className="size-4" />
                </span>
              ) : (
                <Link href={buildHref({ page: page + 1 })}>
                  Next
                  <ChevronRight aria-hidden className="size-4" />
                </Link>
              )}
            </Button>
          </nav>
        </CardContent>
      </Card>
    </div>
  );
}
