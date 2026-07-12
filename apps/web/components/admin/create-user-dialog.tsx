"use client";

import * as React from "react";
import { AlertCircle, UserPlus } from "lucide-react";

import { createUserAccount, type CreateUserAccountResult } from "@/app/dashboard/users/actions";
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
import { TempPasswordReveal } from "@/components/admin/temp-password-reveal";
import { notify } from "@/lib/notify";
import { ROLE_LABELS } from "@/lib/admin/role-labels";
import type { UserRole } from "@/lib/supabase/types";

const INDEX_NUMBER_PATTERN = /^\d{10}$/;
const EMAIL_PATTERN = /^\S+@\S+\.\S+$/;

interface CreateUserDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The signed-in admin/super_admin viewing the page — determines which roles are offered. */
  viewerRole: UserRole;
  onCreated: () => void;
}

interface FormErrors {
  fullName?: string;
  identifier?: string; // email OR indexNumber, depending on role
}

type Step = "form" | "done";

/**
 * Roles `viewerRole` may hand out when CREATING a brand-new account —
 * mirrors CREATABLE_ROLES in app/dashboard/users/actions.ts exactly (which
 * is itself a mirror of set_user_role's escalation rules), so this dialog
 * never offers a role the server action would reject: an admin sees
 * Student/Lecturer; a super_admin sees all four. The server action
 * re-checks this regardless of what the UI offers — this is UX only, same
 * posture as UsersTable's assignableRoles for role changes.
 */
function creatableRoles(viewerRole: UserRole): UserRole[] {
  if (viewerRole === "super_admin") return ["student", "lecturer", "admin", "super_admin"];
  if (viewerRole === "admin") return ["student", "lecturer"];
  return [];
}

/**
 * Admin console counterpart to AddStudentDialog/RosterImportDialog — same
 * "form -> server-validated result -> one-time temp-password reveal"
 * shape, but for ANY role the caller may grant, not just students. See
 * createUserAccount's doc comment (app/dashboard/users/actions.ts) for the
 * escalation enforcement this dialog relies on.
 */
export function CreateUserDialog({ open, onOpenChange, viewerRole, onCreated }: CreateUserDialogProps) {
  const roles = React.useMemo(() => creatableRoles(viewerRole), [viewerRole]);
  const [step, setStep] = React.useState<Step>("form");
  const [fullName, setFullName] = React.useState("");
  const [role, setRole] = React.useState<UserRole>(roles[0] ?? "student");
  const [identifier, setIdentifier] = React.useState(""); // email or index number
  const [phone, setPhone] = React.useState("");
  const [errors, setErrors] = React.useState<FormErrors>({});
  const [saving, setSaving] = React.useState(false);
  const [outcome, setOutcome] = React.useState<CreateUserAccountResult | null>(null);
  const summaryRef = React.useRef<HTMLDivElement>(null);

  const isStudent = role === "student";

  function reset() {
    setStep("form");
    setFullName("");
    setRole(roles[0] ?? "student");
    setIdentifier("");
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
    const trimmedIdentifier = identifier.trim();

    const nextErrors: FormErrors = {};
    if (!trimmedName) nextErrors.fullName = "Full name is required.";
    if (isStudent) {
      if (!INDEX_NUMBER_PATTERN.test(trimmedIdentifier)) {
        nextErrors.identifier = "Index number must be exactly 10 digits.";
      }
    } else if (!EMAIL_PATTERN.test(trimmedIdentifier)) {
      nextErrors.identifier = "Enter a valid email address.";
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      requestAnimationFrame(() => summaryRef.current?.focus());
      return;
    }

    setSaving(true);
    try {
      const result = await createUserAccount({
        fullName: trimmedName,
        role,
        indexNumber: isStudent ? trimmedIdentifier : undefined,
        email: isStudent ? undefined : trimmedIdentifier,
        phone: phone.trim() || null,
      });

      if (result.error) {
        await notify.error("Could not create user", result.error);
        return;
      }

      setOutcome(result);
      setStep("done");
      onCreated();

      if (result.created) {
        // A toast, not notify.success: the temp-password reveal panel below
        // (TempPasswordReveal) is already on screen at this point, and
        // notify.success renders a centered SweetAlert2 modal at a much
        // higher stacking context than this dialog — it would completely
        // cover the very panel it's describing. See TempPasswordReveal's
        // doc comment for the full story.
        await notify.toast({ title: `Account created — ${ROLE_LABELS[role].toLowerCase()}` });
      } else {
        await notify.info(
          "Account already exists",
          `${isStudent ? "That index number" : "That email"} already has an account — nothing was created or changed.`,
        );
      }
    } finally {
      setSaving(false);
    }
  }

  const hasErrors = Object.keys(errors).length > 0;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Create user</DialogTitle>
          <DialogDescription>
            {step === "form"
              ? "Create an account with a chosen role. You can only grant roles you're permitted to assign."
              : "Done."}
          </DialogDescription>
        </DialogHeader>

        {step === "form" ? (
          <form onSubmit={handleSubmit} noValidate id="create-user-form" className="space-y-4">
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
                      <a href="#create-user-fullname" className="underline">
                        Full name: {errors.fullName}
                      </a>
                    </li>
                  ) : null}
                  {errors.identifier ? (
                    <li>
                      <a href="#create-user-identifier" className="underline">
                        {isStudent ? "Index number" : "Email"}: {errors.identifier}
                      </a>
                    </li>
                  ) : null}
                </ul>
              </div>
            ) : null}

            <div className="space-y-2">
              <Label htmlFor="create-user-fullname">Full name</Label>
              <Input
                id="create-user-fullname"
                value={fullName}
                onChange={(event) => setFullName(event.target.value)}
                aria-invalid={Boolean(errors.fullName)}
                aria-describedby={errors.fullName ? "create-user-fullname-error" : undefined}
                autoComplete="off"
                className="min-h-11"
              />
              {errors.fullName ? (
                <p id="create-user-fullname-error" className="text-destructive text-sm">
                  {errors.fullName}
                </p>
              ) : null}
            </div>

            <div className="space-y-2">
              <Label htmlFor="create-user-role">Role</Label>
              <select
                id="create-user-role"
                value={role}
                onChange={(event) => setRole(event.target.value as UserRole)}
                className="border-input h-11 w-full rounded-lg border bg-transparent px-2.5 py-1 text-sm dark:bg-input/30"
              >
                {roles.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
              </select>
              <p className="text-muted-foreground text-xs">
                Only roles you&apos;re permitted to grant are listed.
              </p>
            </div>

            {isStudent ? (
              <div className="space-y-2">
                <Label htmlFor="create-user-identifier">Index number</Label>
                <Input
                  id="create-user-identifier"
                  value={identifier}
                  onChange={(event) => setIdentifier(event.target.value)}
                  inputMode="numeric"
                  maxLength={10}
                  aria-invalid={Boolean(errors.identifier)}
                  aria-describedby={
                    errors.identifier ? "create-user-identifier-error" : "create-user-identifier-hint"
                  }
                  autoComplete="off"
                  className="min-h-11 font-mono"
                />
                {errors.identifier ? (
                  <p id="create-user-identifier-error" className="text-destructive text-sm">
                    {errors.identifier}
                  </p>
                ) : (
                  <p id="create-user-identifier-hint" className="text-muted-foreground text-sm">
                    Exactly 10 digits, e.g. 5201040845. Used to sign in — no email needed.
                  </p>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                <Label htmlFor="create-user-identifier">Email</Label>
                <Input
                  id="create-user-identifier"
                  type="email"
                  value={identifier}
                  onChange={(event) => setIdentifier(event.target.value)}
                  aria-invalid={Boolean(errors.identifier)}
                  aria-describedby={errors.identifier ? "create-user-identifier-error" : undefined}
                  autoComplete="off"
                  className="min-h-11"
                />
                {errors.identifier ? (
                  <p id="create-user-identifier-error" className="text-destructive text-sm">
                    {errors.identifier}
                  </p>
                ) : null}
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="create-user-phone">Phone (optional)</Label>
              <Input
                id="create-user-phone"
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
              <TempPasswordReveal
                title={`New ${ROLE_LABELS[role].toLowerCase()} account created`}
                password={outcome.tempPassword}
                description="They must change this password the first time they sign in."
              />
            ) : (
              <p className="text-sm">
                {isStudent ? "That index number" : "That email"} already has an account — nothing was
                created or changed. Use the role <code>select</code> in the users table to change an
                existing account&apos;s role.
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
              <Button type="submit" form="create-user-form" disabled={saving || roles.length === 0}>
                <UserPlus aria-hidden />
                {saving ? "Creating…" : "Create user"}
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
