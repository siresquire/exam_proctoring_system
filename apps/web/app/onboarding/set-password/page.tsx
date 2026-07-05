import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { SetPasswordForm } from "@/components/onboarding/set-password-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DASHBOARD_BY_ROLE, requireSignedIn } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Set your password — USTED Exam Proctoring",
};

/**
 * Phase 3a first-login gate: shown to any signed-in user whose
 * profiles.must_change_password is true (temp-password accounts —
 * students created via CSV import, or anyone whose password was just
 * regenerated). requireRole() redirects here automatically for every other
 * page; this page uses requireSignedIn() instead so it doesn't redirect to
 * itself, and sends an already-cleared user straight to their dashboard so
 * this URL isn't a dead end after the flag clears.
 */
export default async function SetPasswordPage() {
  const session = await requireSignedIn();
  if (!session.profile.must_change_password) {
    redirect(DASHBOARD_BY_ROLE[session.profile.role]);
  }

  return (
    <div className="mx-auto flex max-w-md flex-col px-4 py-16 sm:px-6">
      <Card>
        <CardHeader>
          <CardTitle>
            <h1 className="text-xl font-semibold tracking-tight">Set your password</h1>
          </CardTitle>
          <CardDescription>
            You signed in with a temporary password. Choose a new password to continue — you
            won&apos;t be asked again after this.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SetPasswordForm />
        </CardContent>
      </Card>
    </div>
  );
}
