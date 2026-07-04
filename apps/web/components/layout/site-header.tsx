import Link from "next/link";

import { ThemeToggle } from "@/components/layout/theme-toggle";

const NAV_LINKS = [
  { href: "/", label: "Home" },
  { href: "/dashboard/student", label: "Student" },
  { href: "/dashboard/lecturer", label: "Lecturer" },
  { href: "/dashboard/admin", label: "Admin" },
  { href: "/dashboard/super-admin", label: "Super Admin" },
  { href: "/design", label: "Design system" },
];

export function SiteHeader() {
  return (
    <header className="bg-background border-b">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-6">
        <Link href="/" className="text-lg font-semibold tracking-tight">
          USTED Proctoring
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
        <ThemeToggle />
      </div>
    </header>
  );
}
