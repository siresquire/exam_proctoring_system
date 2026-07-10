import type { Metadata } from "next";
import { Suspense } from "react";
import Image from "next/image";
import { redirect } from "next/navigation";
import { TriangleAlert } from "lucide-react";

import { LoginForm } from "@/components/auth/login-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DASHBOARD_BY_ROLE, getSessionProfile } from "@/lib/auth";
import { isSupabaseConfigured } from "@/lib/supabase/env";

export const metadata: Metadata = {
  title: "Sign in — USTED Exam Proctoring",
};

export default async function LoginPage() {
  // Already signed in? Straight to their dashboard.
  const session = await getSessionProfile();
  if (session) {
    redirect(DASHBOARD_BY_ROLE[session.profile.role]);
  }

  return (
    <div className="mx-auto flex max-w-md flex-col px-4 py-16 sm:px-6">
      <Image
        src="/aamusted-logo.png"
        alt="USTED — University of Skills Training and Entrepreneurial Development"
        width={400}
        height={116}
        className="mx-auto mb-8 h-auto w-full max-w-xs"
        priority
      />
      <Card>
        <CardHeader>
          <CardTitle>
            <h1 className="text-xl font-semibold tracking-tight">Sign in</h1>
          </CardTitle>
          <CardDescription>
            Use your university account to access the USTED exam platform.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isSupabaseConfigured() ? (
            // useSearchParams inside LoginForm needs a Suspense boundary.
            <Suspense fallback={null}>
              <LoginForm />
            </Suspense>
          ) : (
            <NotConfigured />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * Friendly degraded state when the Supabase env vars are absent (fresh
 * clone, CI build, or a misconfigured deployment) — sign-in simply isn't
 * possible yet, and crashing would help nobody.
 */
function NotConfigured() {
  return (
    <div role="status" className="bg-muted text-muted-foreground rounded-md p-4 text-sm">
      <p className="text-foreground flex items-center gap-2 font-medium">
        <TriangleAlert aria-hidden="true" className="size-4" />
        Sign-in is not configured yet
      </p>
      <p className="mt-2">
        This site is not yet connected to an account system. Please check back later or contact
        your administrator.
      </p>
    </div>
  );
}
