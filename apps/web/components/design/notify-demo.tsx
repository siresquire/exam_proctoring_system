"use client";

import { AlertTriangle, Bell, CheckCircle2, Info, ShieldAlert, XCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { notify } from "@/lib/notify";

/**
 * Exercises every `notify.*` variant. This is the review surface for
 * lib/notify.ts — every popup on the platform should look and behave like
 * one of these.
 */
export function NotifyDemo() {
  return (
    <div className="flex flex-wrap gap-3">
      <Button
        className="min-h-11"
        variant="outline"
        onClick={() => notify.success("Saved", "Your answer was saved.")}
      >
        <CheckCircle2 aria-hidden="true" />
        Success
      </Button>
      <Button
        className="min-h-11"
        variant="outline"
        onClick={() => notify.error("Something went wrong", "Please try again.")}
      >
        <XCircle aria-hidden="true" />
        Error
      </Button>
      <Button
        className="min-h-11"
        variant="outline"
        onClick={() => notify.warning("Unanswered questions", "3 questions are still unanswered.")}
      >
        <AlertTriangle aria-hidden="true" />
        Warning
      </Button>
      <Button
        className="min-h-11"
        variant="outline"
        onClick={() => notify.info("Heads up", "The exam window closes in 10 minutes.")}
      >
        <Info aria-hidden="true" />
        Info
      </Button>
      <Button
        className="min-h-11"
        variant="outline"
        onClick={async () => {
          const confirmed = await notify.confirm({
            title: "Submit exam?",
            text: "You cannot change your answers after submitting.",
            confirmButtonText: "Submit",
            destructive: true,
          });
          if (confirmed) notify.toast({ title: "Exam submitted" });
        }}
      >
        <ShieldAlert aria-hidden="true" />
        Confirm
      </Button>
      <Button
        className="min-h-11"
        variant="outline"
        onClick={() => notify.toast({ title: "Saved 12:04:31" })}
      >
        <Bell aria-hidden="true" />
        Toast
      </Button>
      <Button
        className="min-h-11"
        variant="secondary"
        onClick={() =>
          notify.examWarning(
            "Tab switch detected",
            "This has been logged. Please stay on the exam tab.",
          )
        }
      >
        <Info aria-hidden="true" />
        Exam warning
      </Button>
    </div>
  );
}
