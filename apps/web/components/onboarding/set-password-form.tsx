"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, KeyRound } from "lucide-react";

import { setNewPassword } from "@/app/onboarding/set-password/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { notify } from "@/lib/notify";

interface FormErrors {
  password?: string;
  confirmPassword?: string;
}

const MIN_PASSWORD_LENGTH = 8;

/** Very small, non-blocking strength hint — never blocks submission on its own (only length + match are hard requirements). */
function strengthHint(password: string): string {
  if (!password) return "At least 8 characters. Mixing letters, numbers, and symbols makes it stronger.";
  if (password.length < MIN_PASSWORD_LENGTH) return `${MIN_PASSWORD_LENGTH - password.length} more character(s) needed.`;
  const varietyCount = [/[a-z]/, /[A-Z]/, /\d/, /[^a-zA-Z0-9]/].filter((re) => re.test(password)).length;
  if (varietyCount <= 1) return "Consider adding a number, a capital letter, or a symbol for a stronger password.";
  if (varietyCount === 2) return "Decent password. Adding more character variety makes it stronger still.";
  return "Strong password.";
}

/**
 * Phase 3a forced first-login password change form. Follows DESIGN.md's
 * accessible-form pattern (always-visible labels, aria-describedby-linked
 * inline errors, an error summary that receives focus on failed submit,
 * feedback via notify.*) — same shape as LoginForm/AccessibleFormDemo.
 */
export function SetPasswordForm() {
  const router = useRouter();
  const [password, setPassword] = React.useState("");
  const [confirmPassword, setConfirmPassword] = React.useState("");
  const [errors, setErrors] = React.useState<FormErrors>({});
  const [pending, setPending] = React.useState(false);
  const summaryRef = React.useRef<HTMLDivElement>(null);

  function validate(): FormErrors {
    const nextErrors: FormErrors = {};
    if (password.length < MIN_PASSWORD_LENGTH) {
      nextErrors.password = `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
    }
    if (confirmPassword !== password) {
      nextErrors.confirmPassword = "This doesn't match the new password above.";
    }
    return nextErrors;
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextErrors = validate();
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      requestAnimationFrame(() => summaryRef.current?.focus());
      return;
    }

    setPending(true);
    try {
      const result = await setNewPassword(password, confirmPassword);
      if (result.error) {
        await notify.error("Could not set your password", result.error);
        return;
      }
      await notify.success("Password set", "You're all set. Taking you to your dashboard now.");
      router.push("/dashboard");
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  const hasErrors = Object.keys(errors).length > 0;

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-4">
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
            {errors.password ? (
              <li>
                <a href="#new-password" className="underline">
                  New password: {errors.password}
                </a>
              </li>
            ) : null}
            {errors.confirmPassword ? (
              <li>
                <a href="#confirm-password" className="underline">
                  Confirm password: {errors.confirmPassword}
                </a>
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}

      <div className="space-y-2">
        <Label htmlFor="new-password">New password</Label>
        <Input
          id="new-password"
          name="password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          aria-invalid={Boolean(errors.password)}
          aria-describedby={errors.password ? "new-password-error" : "new-password-hint"}
          className="min-h-11"
        />
        {errors.password ? (
          <p id="new-password-error" className="text-destructive text-sm">
            {errors.password}
          </p>
        ) : (
          <p id="new-password-hint" className="text-muted-foreground text-sm" aria-live="polite">
            {strengthHint(password)}
          </p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="confirm-password">Confirm new password</Label>
        <Input
          id="confirm-password"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
          aria-invalid={Boolean(errors.confirmPassword)}
          aria-describedby={errors.confirmPassword ? "confirm-password-error" : undefined}
          className="min-h-11"
        />
        {errors.confirmPassword ? (
          <p id="confirm-password-error" className="text-destructive text-sm">
            {errors.confirmPassword}
          </p>
        ) : null}
      </div>

      <Button type="submit" disabled={pending} className="min-h-11 w-full">
        <KeyRound aria-hidden="true" />
        {pending ? "Saving…" : "Set password and continue"}
      </Button>
    </form>
  );
}
