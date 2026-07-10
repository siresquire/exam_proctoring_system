import Image from "next/image";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const ROLE_LINKS = [
  { href: "/dashboard/student", label: "Student", description: "Exams, results, appeals." },
  {
    href: "/dashboard/lecturer",
    label: "Lecturer",
    description: "Question banks, exams, live monitoring.",
  },
  { href: "/dashboard/admin", label: "Admin", description: "Classes, lecturers, exam windows." },
  {
    href: "/dashboard/super-admin",
    label: "Super Admin",
    description: "Platform health, audit log, storage.",
  },
];

export default function Home() {
  return (
    <div className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-6xl flex-col px-4 py-16 sm:px-6">
      <section className="flex-1">
        <Image
          src="/aamusted-logo.png"
          alt="USTED — University of Skills Training and Entrepreneurial Development"
          width={480}
          height={139}
          className="mb-6 h-auto w-full max-w-md"
          priority
        />
        <h1 className="text-3xl font-semibold tracking-tight">USTED Exam Proctoring</h1>
        <p className="text-muted-foreground mt-3 max-w-2xl text-lg">
          A proctored exam platform built on evidence and human review, not automated punishment.
          Pick a role below to see its dashboard.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Button asChild>
            <Link href="/design">View design system</Link>
          </Button>
        </div>
      </section>

      <section aria-label="Role dashboards" className="mt-10 grid gap-4 sm:grid-cols-2">
        {ROLE_LINKS.map((role) => (
          <Link key={role.href} href={role.href} className="block">
            <Card className="hover:bg-accent/50 h-full transition-colors">
              <CardHeader>
                <CardTitle>{role.label}</CardTitle>
                <CardDescription>{role.description}</CardDescription>
              </CardHeader>
            </Card>
          </Link>
        ))}
      </section>

      <footer className="text-muted-foreground mt-16 border-t pt-6 text-sm">
        <p>
          USTED — University of Skills Training and Entrepreneurial Development. Secure, fair exams
          for every student and lecturer on campus.
        </p>
      </footer>
    </div>
  );
}
