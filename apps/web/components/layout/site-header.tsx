import Image from "next/image";
import Link from "next/link";

import { FontSizeControl } from "@/components/layout/font-size-control";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { UserMenu } from "@/components/layout/user-menu";
import { getSessionProfile } from "@/lib/auth";

const NAV_LINKS = [
  { href: "/", label: "Home" },
  { href: "/dashboard/student", label: "Student" },
  { href: "/dashboard/lecturer", label: "Lecturer" },
  { href: "/dashboard/admin", label: "Admin" },
  { href: "/dashboard/super-admin", label: "Super Admin" },
  { href: "/proctor-demo", label: "Proctoring demo" },
  { href: "/design", label: "Design system" },
];

// Server component: resolves the session exactly once per request (reusing
// the same cookie-bound server client the page/layout already used) and
// passes it down as props. See UserMenu's doc comment for why this must not
// be re-fetched client-side.
export async function SiteHeader() {
  const session = await getSessionProfile();

  return (
    <header className="bg-background border-b">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-6">
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
        <nav aria-label="Primary" className="flex flex-wrap items-center gap-1">
          {NAV_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="text-muted-foreground hover:bg-accent hover:text-accent-foreground rounded-md px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none"
            >
              {link.label}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          {/* Hidden when signed out. */}
          {session ? (
            <UserMenu
              role={session.profile.role}
              fullName={session.profile.full_name}
              email={session.user.email ?? null}
            />
          ) : null}
          <FontSizeControl />
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
