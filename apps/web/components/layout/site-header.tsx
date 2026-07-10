import Image from "next/image";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { AccountMenu } from "@/components/layout/account-menu";
import { DisplaySettingsMenu } from "@/components/layout/display-settings-menu";
import { getNavGroups } from "@/components/layout/nav-config";
import { DesktopNav, MobileNav } from "@/components/layout/primary-nav";
import { getSessionProfile } from "@/lib/auth";

// Server component: resolves the session exactly once per request (reusing
// the same cookie-bound server client the page/layout already used) and
// passes it down as props. AccountMenu / DesktopNav / MobileNav all take
// role/name/email as props — no client-side session fetch — so the Phase
// 1.6b refresh-hardening fix (single server-side session read, no second
// GoTrue client racing the middleware's refresh) is untouched.
//
// Layout: brand (left, fixed) · inline role nav (middle, desktop only,
// scrolls if a heavy role overflows) · compact right cluster (display/a11y
// settings + circular account avatar; the hamburger replaces the inline nav
// below lg). Compacting the account + settings into an avatar + one icon is
// what frees the horizontal room for the nav to lay out inline without
// wrapping into the brand.
export async function SiteHeader() {
  const session = await getSessionProfile();
  const navGroups = session ? getNavGroups(session.profile.role) : [];

  return (
    <header className="bg-background border-b">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
        <Link
          href="/"
          className="flex shrink-0 items-center gap-2 text-lg font-semibold tracking-tight"
        >
          <Image
            src="/aamusted-logo.png"
            alt="USTED — University of Skills Training and Entrepreneurial Development"
            width={160}
            height={46}
            className="h-10 w-auto"
            priority
          />
          <span className="sr-only whitespace-nowrap sm:not-sr-only">USTED Proctoring</span>
        </Link>

        {session ? <DesktopNav groups={navGroups} /> : null}

        <div className="flex shrink-0 items-center gap-2">
          <DisplaySettingsMenu />
          {session ? (
            <>
              <AccountMenu
                role={session.profile.role}
                fullName={session.profile.full_name}
                email={session.user.email ?? null}
              />
              <MobileNav groups={navGroups} />
            </>
          ) : (
            <Button asChild size="sm">
              <Link href="/login">Sign in</Link>
            </Button>
          )}
        </div>
      </div>
    </header>
  );
}
