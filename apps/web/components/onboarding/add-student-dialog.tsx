"use client";

import * as React from "react";
import { AlertCircle, Copy, UserPlus } from "lucide-react";

import { addStudentToClass, type AddStudentResult } from "@/app/dashboard/lecturer/classes/actions";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { notify } from "@/lib/notify";

interface AddStudentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  classId: string;
  className: string;
  onAdded: (result: { studentId: string; tempPassword: string | null }) => void;
}

interface FormErrors {
  fullName?: string;
  indexNumber?: string;
}

type Step = "form" | "done";

const INDEX_NUMBER_PATTERN = /^\d{10}$/;

/**
 * Single-student add flow, alongside RosterImportDialog's CSV path. Same
 * server action call shape and the same "temp password shown once" result
 * screen — see addStudentToClass in app/dashboard/lecturer/classes/actions.ts,
 * which reuses createOrFindStudent + enroll_existing_student exactly like
 * the CSV importer does for each row.
 */
export function AddStudentDialog({ open, onOpenChange, classId, className, onAdded }: AddStudentDialogProps) {
  const [step, setStep] = React.useState<Step>("form");
  const [fullName, setFullName] = React.useState("");
  const [indexNumber, setIndexNumber] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [errors, setErrors] = React.useState<FormErrors>({});
  const [saving, setSaving] = React.useState(false);
  const [outcome, setOutcome] = React.useState<AddStudentResult | null>(null);
  const summaryRef = React.useRef<HTMLDivElement>(null);

  function reset() {
    setStep("form");
    setFullName("");
    setIndexNumber("");
    setPhone("");
    setErrors({});
    setOutcome(null);
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmedName = fullName.trim();
    const trimmedIndex = indexNumber.trim();

    const nextErrors: FormErrors = {};
    if (!trimmedName) nextErrors.fullName = "Full name is required.";
    if (!INDEX_NUMBER_PATTERN.test(trimmedIndex)) {
      nextErrors.indexNumber = "Index number must be exactly 10 digits.";
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      requestAnimationFrame(() => summaryRef.current?.focus());
      return;
    }

    setSaving(true);
    try {
      const result = await addStudentToClass(classId, {
        fullName: trimmedName,
        indexNumber: trimmedIndex,
        phone: phone.trim() || null,
      });

      if (result.fieldErrors) {
        setErrors(result.fieldErrors);
        requestAnimationFrame(() => summaryRef.current?.focus());
        return;
      }
      if (result.error) {
        await notify.error("Could not add student", result.error);
        return;
      }

      setOutcome(result);
      setStep("done");
      onAdded({
        studentId: result.studentId!,
        tempPassword: result.created ? (result.tempPassword ?? null) : null,
      });

      if (result.alreadyEnrolled) {
        await notify.info(
          "Already enrolled",
          `${trimmedName} is already on this class's roster — nothing changed.`,
        );
      } else if (result.created) {
        await notify.success(
          "Student added",
          "A new account was created. Copy the one-time temp password below.",
        );
      } else {
        await notify.success(
          "Existing student enrolled",
          `${trimmedName} already had an account — enrolled in ${className}.`,
        );
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleCopy() {
    if (!outcome?.tempPassword) return;
    await navigator.clipboard.writeText(outcome.tempPassword);
    await notify.toast({ title: "Temp password copied" });
  }

  const hasErrors = Object.keys(errors).length > 0;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add student — {className}</DialogTitle>
          <DialogDescription>
            {step === "form"
              ? "Add one student directly. An existing index number is enrolled, not duplicated."
              : "Done."}
          </DialogDescription>
        </DialogHeader>

        {step === "form" ? (
          <form onSubmit={handleSubmit} noValidate id="add-student-form" className="space-y-4">
            {hasErrors ? (
              <div
                ref={summaryRef}
                tabIndex={-1}
                role="alert"
                className="border-destructive/40 bg-destructive/10 rounded-md border p-4 text-sm text-[oklch(0.5_0.245_27.325)] dark:text-[oklch(0.85_0.191_22.216)]"
              >
                <p className="flex items-center gap-2 font-medium">
                  <AlertCircle aria-hidden="true" className="size-4" />
                  Please fix {Object.keys(errors).length === 1 ? "this problem" : "these problems"}:
                </p>
                <ul className="mt-2 list-inside list-disc">
                  {errors.fullName ? (
                    <li>
                      <a href="#add-student-fullname" className="underline">
                        Full name: {errors.fullName}
                      </a>
                    </li>
                  ) : null}
                  {errors.indexNumber ? (
                    <li>
                      <a href="#add-student-index" className="underline">
                        Index number: {errors.indexNumber}
                      </a>
                    </li>
                  ) : null}
                </ul>
              </div>
            ) : null}

            <div className="space-y-2">
              <Label htmlFor="add-student-fullname">Full name</Label>
              <Input
                id="add-student-fullname"
                value={fullName}
                onChange={(event) => setFullName(event.target.value)}
                aria-invalid={Boolean(errors.fullName)}
                aria-describedby={errors.fullName ? "add-student-fullname-error" : undefined}
                autoComplete="off"
                className="min-h-11"
              />
              {errors.fullName ? (
                <p id="add-student-fullname-error" className="text-destructive text-sm">
                  {errors.fullName}
                </p>
              ) : null}
            </div>

            <div className="space-y-2">
              <Label htmlFor="add-student-index">Index number</Label>
              <Input
                id="add-student-index"
                value={indexNumber}
                onChange={(event) => setIndexNumber(event.target.value)}
                inputMode="numeric"
                maxLength={10}
                aria-invalid={Boolean(errors.indexNumber)}
                aria-describedby={errors.indexNumber ? "add-student-index-error" : "add-student-index-hint"}
                autoComplete="off"
                className="min-h-11 font-mono"
              />
              {errors.indexNumber ? (
                <p id="add-student-index-error" className="text-destructive text-sm">
                  {errors.indexNumber}
                </p>
              ) : (
                <p id="add-student-index-hint" className="text-muted-foreground text-sm">
                  Exactly 10 digits, e.g. 5201040845.
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="add-student-phone">Phone (optional)</Label>
              <Input
                id="add-student-phone"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                inputMode="tel"
                autoComplete="off"
                className="min-h-11"
              />
            </div>
          </form>
        ) : (
          <div className="space-y-4">
            {outcome?.created && outcome.tempPassword ? (
              <div className="space-y-2 rounded-md border p-3">
                <p className="text-sm">
                  New account created. This temp password is shown <strong>once</strong> — copy it now.
                </p>
                <div className="flex items-center gap-2">
                  <code className="bg-muted flex-1 rounded px-2 py-1.5 font-mono text-sm">
                    {outcome.tempPassword}
                  </code>
                  <Button type="button" variant="outline" size="sm" onClick={handleCopy} className="min-h-11">
                    <Copy aria-hidden />
                    Copy
                  </Button>
                </div>
              </div>
            ) : outcome?.alreadyEnrolled ? (
              <p className="text-sm">
                {outcome.fullName ?? "This student"} was already enrolled in {className} — nothing changed.
              </p>
            ) : (
              <p className="text-sm">
                Existing account found for index {outcome?.indexNumber} — enrolled in {className}.
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          {step === "form" ? (
            <>
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} disabled={saving}>
                Cancel
              </Button>
              <Button type="submit" form="add-student-form" disabled={saving}>
                <UserPlus aria-hidden />
                {saving ? "Adding…" : "Add student"}
              </Button>
            </>
          ) : (
            <Button type="button" onClick={() => handleOpenChange(false)}>
              Done
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
