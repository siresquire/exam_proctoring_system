import Image from "next/image";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { FontSizeControl } from "@/components/layout/font-size-control";
import { getNavGroups } from "@/components/layout/nav-config";
import { PrimaryNav } from "@/components/layout/primary-nav";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { UserMenu } from "@/components/layout/user-menu";
import { getSessionProfile } from "@/lib/auth";

// Server component: resolves the session exactly once per request (reusing
// the same cookie-bound server client the page/layout already used) and
// passes it down as props. See UserMenu's doc comment for why this must not
// be re-fetched client-side. PrimaryNav (the role-filtered links + mobile
// Sheet drawer) follows the same pattern: role/name/email come in as props,
// no client-side session fetch, so the Phase 1.6b refresh-hardening fix
// (single server-side session read, no second GoTrue client racing the
// middleware's refresh) is untouched.
export async function SiteHeader() {
  const session = await getSessionProfile();
  const navGroups = session ? getNavGroups(session.profile.role) : [];

  return (
    <header className="bg-background border-b">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          <Image
            src="/aamusted-logo.png"
            alt="AAMUSTED — University of Skills Training and Entrepreneurial Development"
            width={160}
            height={46}
            className="h-10 w-auto"
            priority
          />
          <span className="sr-only sm:not-sr-only">USTED Proctoring</span>
        </Link>

        {session ? (
          <PrimaryNav
            groups={navGroups}
            session={{
              role: session.profile.role,
              fullName: session.profile.full_name,
              email: session.user.email ?? null,
            }}
          />
        ) : null}

        <div className="hidden items-center gap-2 md:flex">
          {/* Hidden when signed out. */}
          {session ? (
            <UserMenu
              role={session.profile.role}
              fullName={session.profile.full_name}
              email={session.user.email ?? null}
            />
          ) : (
            <Button asChild size="sm">
              <Link href="/login">Sign in</Link>
            </Button>
          )}
          <FontSizeControl />
          <ThemeToggle />
        </div>

        {/* Signed-out mobile: no hamburger (no app links to show), just Sign in. */}
        {!session ? (
          <Button asChild size="sm" className="md:hidden">
            <Link href="/login">Sign in</Link>
          </Button>
        ) : null}
      </div>
    </header>
  );
}
