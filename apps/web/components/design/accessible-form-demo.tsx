"use client";

import * as React from "react";
import { AlertCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { notify } from "@/lib/notify";

interface FormErrors {
  fullName?: string;
  studentId?: string;
}

/**
 * Reference implementation of DESIGN.md's inline-error pattern:
 * - Labels are always visible (never placeholder-as-label)
 * - Each invalid field is linked to its message via aria-describedby
 * - An error summary appears at the top, and focus moves to it, on submit
 * - Errors state what happened and what to do next in plain language
 */
export function AccessibleFormDemo() {
  const [errors, setErrors] = React.useState<FormErrors>({});
  const summaryRef = React.useRef<HTMLDivElement>(null);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const fullName = String(formData.get("fullName") ?? "").trim();
    const studentId = String(formData.get("studentId") ?? "").trim();

    const nextErrors: FormErrors = {};
    if (!fullName) nextErrors.fullName = "Enter your full name as it appears on your ID.";
    if (!studentId) nextErrors.studentId = "Enter your student ID (e.g. UST/2024/0001).";

    setErrors(nextErrors);

    if (Object.keys(nextErrors).length > 0) {
      // Move focus to the error summary so screen-reader and keyboard users
      // land on the list of problems immediately, rather than needing to
      // hunt through the form.
      requestAnimationFrame(() => summaryRef.current?.focus());
      return;
    }

    void notify.success("Details saved");
    event.currentTarget.reset();
  }

  const hasErrors = Object.keys(errors).length > 0;

  return (
    <form onSubmit={handleSubmit} noValidate className="max-w-md space-y-4">
      {hasErrors ? (
        <div
          ref={summaryRef}
          tabIndex={-1}
          role="alert"
          // Plain `text-destructive` on the 10%-tint background measures
          // ~4.0:1, under the 4.5:1 AA minimum. Darkening just the text
          // (not the badge/button tokens, which use solid backgrounds
          // instead) keeps this specific "soft alert box" pattern usable.
          className="border-destructive/40 bg-destructive/10 rounded-md border p-4 text-sm text-[oklch(0.5_0.245_27.325)] dark:text-[oklch(0.85_0.191_22.216)]"
        >
          <p className="flex items-center gap-2 font-medium">
            <AlertCircle aria-hidden="true" className="size-4" />
            Please fix {Object.keys(errors).length === 1 ? "this problem" : "these problems"}:
          </p>
          <ul className="mt-2 list-inside list-disc">
            {errors.fullName ? (
              <li>
                <a href="#fullName" className="underline">
                  Full name: {errors.fullName}
                </a>
              </li>
            ) : null}
            {errors.studentId ? (
              <li>
                <a href="#studentId" className="underline">
                  Student ID: {errors.studentId}
                </a>
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}

      <div className="space-y-2">
        <Label htmlFor="fullName">Full name</Label>
        <Input
          id="fullName"
          name="fullName"
          aria-invalid={Boolean(errors.fullName)}
          aria-describedby={errors.fullName ? "fullName-error" : undefined}
          className="min-h-11"
        />
        {errors.fullName ? (
          <p id="fullName-error" className="text-destructive text-sm">
            {errors.fullName}
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="studentId">Student ID</Label>
        <Input
          id="studentId"
          name="studentId"
          aria-invalid={Boolean(errors.studentId)}
          aria-describedby={errors.studentId ? "studentId-error" : undefined}
          className="min-h-11"
        />
        {errors.studentId ? (
          <p id="studentId-error" className="text-destructive text-sm">
            {errors.studentId}
          </p>
        ) : null}
      </div>

      <Button type="submit" className="min-h-11">
        Save details
      </Button>
    </form>
  );
}
