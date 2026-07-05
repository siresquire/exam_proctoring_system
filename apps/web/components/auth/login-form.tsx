"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { AlertCircle, KeyRound, Mail } from "lucide-react";

import { signIn } from "@/app/login/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { notify } from "@/lib/notify";
import { createClientOrThrow } from "@/lib/supabase/client";

interface FormErrors {
  identifier?: string;
  password?: string;
}

const INDEX_NUMBER_PATTERN = /^\d{10}$/;
const EMAIL_PATTERN = /^\S+@\S+\.\S+$/;

const CALLBACK_ERROR_MESSAGES: Record<string, string> = {
  auth_callback: "That sign-in link is invalid or has expired. Request a new one and try again.",
  not_configured: "The server is not connected to Supabase yet. Contact the administrator.",
};

/**
 * Email-or-index-number/password + magic-link sign-in. Follows DESIGN.md's
 * accessible form pattern: always-visible labels, inline errors linked via
 * aria-describedby, an error summary that receives focus on failed submit,
 * and all feedback through notify.* (never raw alerts).
 *
 * The password tab submits through the `signIn` server action
 * (app/login/actions.ts) rather than calling `supabase.auth.signInWithPassword`
 * from the browser — that's what makes index-number identifiers possible at
 * all (resolving one to an email requires the service-role client, which is
 * server-only) and, as a side benefit, writes the session cookie through the
 * same SSR client the rest of the app trusts, instead of a second
 * browser-side session that has caused refresh-token races in the past (see
 * lib/supabase/client.ts's doc comment).
 */
export function LoginForm() {
  const searchParams = useSearchParams();
  const [errors, setErrors] = React.useState<FormErrors>({});
  const [pending, setPending] = React.useState(false);
  const summaryRef = React.useRef<HTMLDivElement>(null);

  // Surface /auth/callback failures (expired magic link etc.) exactly once.
  const callbackError = searchParams.get("error");
  const announcedRef = React.useRef(false);
  React.useEffect(() => {
    if (callbackError && !announcedRef.current) {
      announcedRef.current = true;
      void notify.error(
        "Sign-in failed",
        CALLBACK_ERROR_MESSAGES[callbackError] ?? "Something went wrong. Please try again.",
      );
    }
  }, [callbackError]);

  function focusSummary() {
    requestAnimationFrame(() => summaryRef.current?.focus());
  }

  function validatePassword(formData: FormData): FormErrors {
    const identifier = String(formData.get("identifier") ?? "").trim();
    const password = String(formData.get("password") ?? "");

    const nextErrors: FormErrors = {};
    if (!identifier) {
      nextErrors.identifier = "Enter your email address or 10-digit index number.";
    } else if (!EMAIL_PATTERN.test(identifier) && !INDEX_NUMBER_PATTERN.test(identifier)) {
      nextErrors.identifier =
        "Enter a valid email address (e.g. you@usted.edu.gh) or a 10-digit index number.";
    }
    if (!password) {
      nextErrors.password = "Enter your password.";
    }
    return nextErrors;
  }

  function validateEmail(formData: FormData): FormErrors {
    const email = String(formData.get("email") ?? "").trim();
    const nextErrors: FormErrors = {};
    if (!email) {
      nextErrors.identifier = "Enter your university email address.";
    } else if (!EMAIL_PATTERN.test(email)) {
      nextErrors.identifier = "Enter a valid email address (e.g. you@usted.edu.gh).";
    }
    return nextErrors;
  }

  async function handlePasswordSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const nextErrors = validatePassword(formData);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      focusSummary();
      return;
    }

    setPending(true);
    try {
      const result = await signIn(
        String(formData.get("identifier")).trim(),
        String(formData.get("password")),
      );
      // A successful signIn() redirects server-side and never returns —
      // reaching here always means it failed. Generic message by design
      // (see the server action's doc comment: no enumeration oracle).
      if (result?.error) {
        void notify.error("Sign-in failed", result.error);
      }
    } finally {
      setPending(false);
    }
  }

  async function handleMagicLinkSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const nextErrors = validateEmail(formData);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      focusSummary();
      return;
    }

    const email = String(formData.get("email")).trim();
    setPending(true);
    try {
      const supabase = createClientOrThrow();
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback?next=/dashboard`,
        },
      });

      if (error) {
        void notify.error("Could not send the link", error.message);
        return;
      }

      void notify.success(
        "Check your email",
        `We sent a sign-in link to ${email}. It expires in about an hour.`,
      );
    } finally {
      setPending(false);
    }
  }

  const hasErrors = Object.keys(errors).length > 0;

  const errorSummary = hasErrors ? (
    <div
      ref={summaryRef}
      tabIndex={-1}
      role="alert"
      // Same darkened-text treatment as the reference accessible form —
      // plain text-destructive on the 10% tint measures under 4.5:1.
      className="border-destructive/40 bg-destructive/10 rounded-md border p-4 text-sm text-[oklch(0.5_0.245_27.325)] dark:text-[oklch(0.85_0.191_22.216)]"
    >
      <p className="flex items-center gap-2 font-medium">
        <AlertCircle aria-hidden="true" className="size-4" />
        Please fix {Object.keys(errors).length === 1 ? "this problem" : "these problems"}:
      </p>
      <ul className="mt-2 list-inside list-disc">
        {errors.identifier ? (
          <li>
            <a href="#identifier" className="underline">
              {errors.identifier}
            </a>
          </li>
        ) : null}
        {errors.password ? (
          <li>
            <a href="#password" className="underline">
              Password: {errors.password}
            </a>
          </li>
        ) : null}
      </ul>
    </div>
  ) : null;

  return (
    <Tabs defaultValue="password" onValueChange={() => setErrors({})}>
      <TabsList className="w-full">
        <TabsTrigger value="password">
          <KeyRound aria-hidden="true" className="size-4" />
          Password
        </TabsTrigger>
        <TabsTrigger value="magic-link">
          <Mail aria-hidden="true" className="size-4" />
          Email me a link
        </TabsTrigger>
      </TabsList>

      <TabsContent value="password">
        <form onSubmit={handlePasswordSubmit} noValidate className="space-y-4 pt-2">
          {errorSummary}
          <div className="space-y-2">
            <Label htmlFor="identifier">Email or index number</Label>
            <Input
              id="identifier"
              name="identifier"
              type="text"
              inputMode="email"
              autoComplete="username"
              placeholder="you@usted.edu.gh or 5201040845"
              aria-invalid={Boolean(errors.identifier)}
              aria-describedby={errors.identifier ? "identifier-error" : "identifier-help"}
              className="min-h-11"
            />
            {errors.identifier ? (
              <p id="identifier-error" className="text-destructive text-sm">
                {errors.identifier}
              </p>
            ) : (
              <p id="identifier-help" className="text-muted-foreground text-sm">
                Use your university email, or your 10-digit USTED index number (e.g. 5201040845).
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              aria-invalid={Boolean(errors.password)}
              aria-describedby={errors.password ? "password-error" : undefined}
              className="min-h-11"
            />
            {errors.password ? (
              <p id="password-error" className="text-destructive text-sm">
                {errors.password}
              </p>
            ) : null}
          </div>
          <Button type="submit" disabled={pending} className="min-h-11 w-full">
            {pending ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </TabsContent>

      <TabsContent value="magic-link">
        <form onSubmit={handleMagicLinkSubmit} noValidate className="space-y-4 pt-2">
          <p className="text-muted-foreground text-sm">
            No password needed — we&apos;ll email you a one-time sign-in link. Index number +
            password (the Password tab) is the primary way to sign in for now — email delivery
            needs a verified sending domain, which this deployment does not have configured yet.
          </p>
          {errorSummary}
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              aria-invalid={Boolean(errors.identifier)}
              aria-describedby={errors.identifier ? "email-error" : undefined}
              className="min-h-11"
            />
            {errors.identifier ? (
              <p id="email-error" className="text-destructive text-sm">
                {errors.identifier}
              </p>
            ) : null}
          </div>
          <Button type="submit" disabled={pending} className="min-h-11 w-full">
            {pending ? "Sending link…" : "Send sign-in link"}
          </Button>
        </form>
      </TabsContent>
    </Tabs>
  );
}
