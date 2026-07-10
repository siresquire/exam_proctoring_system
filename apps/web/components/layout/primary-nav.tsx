"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import type { NavGroup, NavLink } from "@/components/layout/nav-config";

function isActive(pathname: string, href: string) {
  if (href === "/dashboard") {
    // /dashboard redirects to the role dashboard, so treat the role roots as
    // "Dashboard" active — a deeper section link (e.g. /dashboard/lecturer/exams)
    // wins via the longest-match in getActiveHref below.
    return (
      pathname === "/dashboard" ||
      /^\/dashboard\/(student|lecturer|admin|super-admin)$/.test(pathname)
    );
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Single best-matching link (longest href) so nested routes highlight one tab, not two. */
function getActiveHref(pathname: string, links: NavLink[]): string | null {
  const matches = links.filter((link) => isActive(pathname, link.href));
  if (matches.length === 0) return null;
  return matches.reduce((best, link) => (link.href.length > best.href.length ? link : best)).href;
}

interface NavProps {
  groups: NavGroup[];
}

/**
 * Desktop inline navigation (lg and up). One non-wrapping row; if a role has
 * enough links to exceed the space (super_admin), the row scrolls
 * horizontally rather than wrapping into the brand — wrapping was the cause
 * of the earlier overlap. Below lg the links live in the MobileNav drawer
 * instead. The compact avatar + settings controls in the header (see
 * AccountMenu / DisplaySettingsMenu) are what free the room for this row.
 */
export function DesktopNav({ groups }: NavProps) {
  const pathname = usePathname();
  const flatLinks = React.useMemo(() => groups.flatMap((g) => g.links), [groups]);
  const activeHref = getActiveHref(pathname, flatLinks);

  return (
    <nav
      aria-label="Primary"
      className="hidden min-w-0 flex-1 items-center gap-1 overflow-x-auto lg:flex"
    >
      {flatLinks.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          aria-current={link.href === activeHref ? "page" : undefined}
          className={cn(
            "focus-visible:ring-ring/50 rounded-md px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-3",
            link.href === activeHref
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
          )}
        >
          {link.label}
        </Link>
      ))}
    </nav>
  );
}

/**
 * Mobile navigation (below lg): a hamburger button that opens a Sheet drawer
 * of the role links. Only the links live here — identity, sign-out, and the
 * display/accessibility settings are always-present in the header via
 * AccountMenu + DisplaySettingsMenu, so they are not duplicated in the
 * drawer. Radix Sheet supplies the focus trap, Escape-to-close, scroll lock,
 * and aria-expanded/haspopup wiring; each link is a SheetClose so tapping it
 * navigates and closes the drawer.
 */
export function MobileNav({ groups }: NavProps) {
  const pathname = usePathname();
  const flatLinks = React.useMemo(() => groups.flatMap((g) => g.links), [groups]);
  const activeHref = getActiveHref(pathname, flatLinks);
  const [open, setOpen] = React.useState(false);

  return (
    <div className="lg:hidden">
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
          {/* One nav landmark for the whole drawer; group labels are plain
              <h2>s, not nested landmarks (axe landmark-unique). */}
          <nav aria-label="Site navigation" className="flex flex-col gap-6 px-4 pb-6">
            {groups.map((group, index) => (
              <div key={group.label ?? `group-${index}`} className="flex flex-col gap-1">
                {group.label ? (
                  <h2 className="text-muted-foreground px-3 text-xs font-semibold tracking-wide uppercase">
                    {group.label}
                  </h2>
                ) : null}
                {group.links.map((link) => (
                  <SheetClose asChild key={link.href}>
                    <Link
                      href={link.href}
                      aria-current={link.href === activeHref ? "page" : undefined}
                      className={cn(
                        "focus-visible:ring-ring/50 flex min-h-11 items-center rounded-md px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-3",
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
        </SheetContent>
      </Sheet>
    </div>
  );
}
