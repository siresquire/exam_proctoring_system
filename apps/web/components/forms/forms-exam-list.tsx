"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { BarChart3, Check, Copy, Pencil, RotateCcw, Square } from "lucide-react";

import {
  closeFormsExam,
  publishFormsExam,
  reopenFormsExamAsDraft,
} from "@/app/dashboard/lecturer/forms-exams/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { notify } from "@/lib/notify";
import type { FormsExamRow } from "@/lib/supabase/types";

const STATUS_VARIANT: Record<string, "secondary" | "default" | "outline"> = {
  draft: "secondary",
  published: "default",
  closed: "outline",
};

function studentLink(id: string): string {
  if (typeof window === "undefined") return `/exam/forms/${id}`;
  return `${window.location.origin}/exam/forms/${id}`;
}

export function FormsExamList({ exams }: { exams: FormsExamRow[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);

  async function handleCopyLink(id: string) {
    const link = studentLink(id);
    try {
      await navigator.clipboard.writeText(link);
      await notify.toast({ title: "Student link copied" });
    } catch {
      await notify.info("Copy this link", link);
    }
  }

  async function handlePublish(id: string) {
    setBusyId(id);
    try {
      const result = await publishFormsExam(id);
      if (result.error) {
        await notify.error("Could not publish", result.error);
        return;
      }
      await notify.success("Published", "Students can now start this quiz within its window.");
      router.refresh();
    } finally {
      setBusyId(null);
    }
  }

  async function handleClose(id: string) {
    const confirmed = await notify.confirm({
      title: "Close this quiz?",
      text: "Students will no longer be able to start new sessions. Already-open sessions are unaffected.",
      confirmButtonText: "Close quiz",
      destructive: true,
    });
    if (!confirmed) return;

    setBusyId(id);
    try {
      const result = await closeFormsExam(id);
      if (result.error) {
        await notify.error("Could not close", result.error);
        return;
      }
      await notify.toast({ title: "Quiz closed" });
      router.refresh();
    } finally {
      setBusyId(null);
    }
  }

  async function handleReopenAsDraft(id: string) {
    setBusyId(id);
    try {
      const result = await reopenFormsExamAsDraft(id);
      if (result.error) {
        await notify.error("Could not reopen", result.error);
        return;
      }
      await notify.toast({ title: "Back to draft" });
      router.refresh();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Table>
      <TableCaption className="sr-only">Your Google Forms quizzes</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>Title</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Tier</TableHead>
          <TableHead>Window</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {exams.map((exam) => (
          <TableRow key={exam.id}>
            <TableCell className="font-medium whitespace-normal">{exam.title}</TableCell>
            <TableCell>
              <Badge variant={STATUS_VARIANT[exam.status] ?? "outline"}>{exam.status}</Badge>
            </TableCell>
            <TableCell>T{exam.integrity_tier}</TableCell>
            <TableCell className="text-muted-foreground text-xs whitespace-normal">
              {exam.opens_at ? new Date(exam.opens_at).toLocaleString() : "Any time"}
              {" – "}
              {exam.closes_at ? new Date(exam.closes_at).toLocaleString() : "No end"}
            </TableCell>
            <TableCell>
              <div className="flex flex-wrap justify-end gap-2">
                <Button asChild variant="ghost" size="sm">
                  <Link href={`/dashboard/lecturer/forms-exams/${exam.id}/edit`}>
                    <Pencil aria-hidden />
                    Edit
                  </Link>
                </Button>
                <Button asChild variant="ghost" size="sm">
                  <Link href={`/dashboard/lecturer/forms-exams/${exam.id}/results`}>
                    <BarChart3 aria-hidden />
                    Results
                  </Link>
                </Button>
                {exam.status === "published" ? (
                  <Button variant="ghost" size="sm" onClick={() => handleCopyLink(exam.id)}>
                    <Copy aria-hidden />
                    Copy link
                  </Button>
                ) : null}
                {exam.status === "draft" ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busyId === exam.id}
                    onClick={() => handlePublish(exam.id)}
                  >
                    <Check aria-hidden />
                    Publish
                  </Button>
                ) : null}
                {exam.status === "published" ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busyId === exam.id}
                    onClick={() => handleClose(exam.id)}
                  >
                    <Square aria-hidden />
                    Close
                  </Button>
                ) : null}
                {exam.status === "closed" ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busyId === exam.id}
                    onClick={() => handleReopenAsDraft(exam.id)}
                  >
                    <RotateCcw aria-hidden />
                    Reopen as draft
                  </Button>
                ) : null}
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
