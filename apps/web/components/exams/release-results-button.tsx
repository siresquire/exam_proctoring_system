"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Send } from "lucide-react";

import { releaseExamResults } from "@/app/dashboard/lecturer/exams/actions";
import { Button } from "@/components/ui/button";
import { notify } from "@/lib/notify";

/**
 * Phase 3d-ii: the manual-release action for exams.results_release='manual'.
 * Only rendered by the results page for that release mode — immediate/
 * after_close exams release automatically (see get_attempt_result), so
 * there is nothing for a lecturer to click there.
 */
export function ReleaseResultsButton({ examId, alreadyReleased }: { examId: string; alreadyReleased: boolean }) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);

  async function handleRelease() {
    const confirmed = await notify.confirm({
      title: "Release results to students?",
      text: "Every student who has submitted this exam will immediately be able to see their score and per-question breakdown. This cannot be undone.",
      confirmButtonText: "Release results",
    });
    if (!confirmed) return;

    setSubmitting(true);
    const result = await releaseExamResults(examId);
    setSubmitting(false);

    if (result.error) {
      await notify.error("Could not release results", result.error);
      return;
    }

    await notify.success("Results released", "Students can now view their results.");
    router.refresh();
  }

  if (alreadyReleased) {
    return (
      <Button variant="outline" disabled>
        <Send aria-hidden />
        Results released
      </Button>
    );
  }

  return (
    <Button onClick={handleRelease} disabled={submitting}>
      <Send aria-hidden />
      {submitting ? "Releasing…" : "Release results"}
    </Button>
  );
}
