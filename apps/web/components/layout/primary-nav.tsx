"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogOut, Menu, UserRound } from "lucide-react";

import { cn } from "@/lib/utils";
import { signOut } from "@/app/auth/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { FontSizeControl } from "@/components/layout/font-size-control";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import type { NavGroup, NavLink } from "@/components/layout/nav-config";
import type { UserRole } from "@/lib/supabase/types";

const ROLE_LABELS: Record<UserRole, string> = {
  super_admin: "Super Admin",
  admin: "Admin",
  lecturer: "Lecturer",
  student: "Student",
};

function isActive(pathname: string, href: string) {
  if (href === "/dashboard") {
    // /dashboard itself redirects to the role dashboard, so treat any
    // /dashboard/* route as "Dashboard" being the active top-level link
    // UNLESS a more specific link below also matches (e.g.
    // /dashboard/lecturer/exams matches both "Dashboard" and "Exams" by
    // prefix — the caller only marks the single longest match, handled by
    // sorting in NavLinkItem's caller).
    return pathname === "/dashboard" || /^\/dashboard\/(student|lecturer|admin|super-admin)$/.test(pathname);
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Picks the single best-matching link (longest href) so nested routes don't highlight two tabs at once. */
function getActiveHref(pathname: string, links: NavLink[]): string | null {
  const matches = links.filter((link) => isActive(pathname, link.href));
  if (matches.length === 0) return null;
  return matches.reduce((best, link) => (link.href.length > best.href.length ? link : best)).href;
}

interface PrimaryNavProps {
  groups: NavGroup[];
  /** Signed-in identity, shown in the mobile drawer footer alongside sign-out. Desktop shows this via the separate UserMenu dropdown in the top bar instead. Null when signed out (drawer omits the identity/sign-out block). */
  session: { role: UserRole; fullName: string | null; email: string | null } | null;
}

/**
 * Role-filtered primary navigation: inline row on desktop (md+), collapsed
 * into a hamburger + Sheet drawer below that. Both renderings share the
 * same `groups` data (already role-scoped server-side by SiteHeader), so
 * this component only handles presentation + active-link + open/close
 * state — no session logic lives here (role/name/email arrive as props,
 * same as UserMenu).
 *
 * The mobile drawer additionally carries the identity + sign-out + text
 * size + theme controls, so the top bar on small screens is just the logo
 * and this hamburger — nothing else competes for space and nothing wraps.
 */
export function PrimaryNav({ groups, session }: PrimaryNavProps) {
  const pathname = usePathname();
  const flatLinks = React.useMemo(() => groups.flatMap((g) => g.links), [groups]);
  const activeHref = getActiveHref(pathname, flatLinks);
  const [open, setOpen] = React.useState(false);
  const [signingOut, setSigningOut] = React.useState(false);

  return (
    <>
      {/* Desktop: inline row, one line at common widths. */}
      <nav aria-label="Primary" className="hidden md:flex md:flex-wrap md:items-center md:gap-1">
        {flatLinks.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            aria-current={link.href === activeHref ? "page" : undefined}
            className={cn(
              "rounded-md px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
              link.href === activeHref
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
            )}
          >
            {link.label}
          </Link>
        ))}
      </nav>

      {/* Mobile: hamburger trigger + Sheet drawer. */}
      <div className="md:hidden">
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger asChild>
            <Button
              variant="outline"
              size="icon"
              className="min-h-11 min-w-11"
              aria-label={open ? "Close menu" : "Open menu"}
            >
              <Menu aria-hidden="true" className="size-5" />
            </Button>
          </SheetTrigger>
          <SheetContent side="right" className="flex flex-col overflow-y-auto">
            <SheetHeader>
              <SheetTitle>Menu</SheetTitle>
            </SheetHeader>
            {/* Single nav landmark for the whole drawer (axe-core's landmark-unique
                flags duplicate unlabeled/same-labeled <nav> elements, which two or
                more ungrouped sections would otherwise produce) — group headings
                below are plain <h2>s, not nested landmarks. */}
            <nav aria-label="Site navigation" className="flex flex-col gap-6 px-4 pb-4">
              {groups.map((group, index) => (
                <div key={group.label ?? `group-${index}`} className="flex flex-col gap-1">
                  {group.label ? (
                    <h2 className="text-muted-foreground px-3 text-xs font-semibold uppercase tracking-wide">
                      {group.label}
                    </h2>
                  ) : null}
                  {group.links.map((link) => (
                    <SheetClose asChild key={link.href}>
                      <Link
                        href={link.href}
                        aria-current={link.href === activeHref ? "page" : undefined}
                        className={cn(
                          "flex min-h-11 items-center rounded-md px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                          link.href === activeHref
                            ? "bg-accent text-accent-foreground"
                            : "text-foreground hover:bg-accent hover:text-accent-foreground",
                        )}
                      >
                        {link.label}
                      </Link>
                    </SheetClose>
                  ))}
                </div>
              ))}
            </nav>
            <SheetFooter className="border-t">
              {session ? (
                <div className="mb-1 flex items-center gap-2 px-3 text-sm">
                  <UserRound aria-hidden="true" className="text-muted-foreground size-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {session.fullName || session.email || "Signed in"}
                  </span>
                  <Badge variant="secondary">{ROLE_LABELS[session.role]}</Badge>
                </div>
              ) : null}
              <div className="flex flex-col gap-2">
                <FontSizeControl />
                <ThemeToggle />
              </div>
              {session ? (
                <Button
                  variant="outline"
                  className="min-h-11 justify-start gap-2"
                  disabled={signingOut}
                  onClick={() => {
                    setSigningOut(true);
                    void signOut();
                  }}
                >
                  <LogOut aria-hidden="true" className="size-4" />
                  {signingOut ? "Signing out…" : "Sign out"}
                </Button>
              ) : null}
            </SheetFooter>
          </SheetContent>
        </Sheet>
      </div>
    </>
  );
}
