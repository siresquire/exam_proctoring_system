import Link from "next/link";
import { PlusCircle, Users } from "lucide-react";

import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Breadcrumbs } from "@/components/layout/breadcrumbs";
import type { ClassRow } from "@/lib/supabase/types";

/**
 * Phase 3a lecturer landing page: lists the lecturer's own classes (RLS's
 * classes_select_owner_or_lecturer policy — "any lecturer" for now, same
 * known simplification as forms_exams/proctor_* elsewhere in this codebase;
 * Phase 4 scopes this to ownership/co-teaching) with a link to create a new
 * one.
 */
export default async function ClassesPage() {
  await requireRole("lecturer", "admin");

  const supabase = await createClient();
  let classes: ClassRow[] = [];
  if (supabase) {
    const { data } = await supabase.from("classes").select("*").order("created_at", { ascending: false });
    classes = data ?? [];
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
      <Breadcrumbs items={[{ label: "Dashboard", href: "/dashboard" }, { label: "Classes" }]} />
      <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Classes</h1>
          <p className="text-muted-foreground mt-2 max-w-2xl">
            Create a class, import students from a CSV, and export a roster with login details —
            no student email address required.
          </p>
        </div>
        <Button asChild>
          <Link href="/dashboard/lecturer/classes/new">
            <PlusCircle aria-hidden />
            New class
          </Link>
        </Button>
      </header>

      {classes.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">No classes yet</CardTitle>
            <CardDescription>Create one to start importing students.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline">
              <Link href="/dashboard/lecturer/classes/new">
                <PlusCircle aria-hidden />
                New class
              </Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2">
          {classes.map((klass) => (
            <li key={klass.id}>
              <Link href={`/dashboard/lecturer/classes/${klass.id}`} className="block">
                <Card className="hover:bg-muted/50 transition-colors">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-base">
                      <Users aria-hidden className="text-primary size-4" />
                      {klass.name}
                    </CardTitle>
                    <CardDescription>
                      {klass.code ? `Code: ${klass.code}` : "No class code"}
                      {klass.description ? ` — ${klass.description}` : ""}
                    </CardDescription>
                  </CardHeader>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
