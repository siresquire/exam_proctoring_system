import type { UserRole } from "@/lib/supabase/types";

export interface NavLink {
  href: string;
  label: string;
}

export interface NavGroup {
  /** Group heading shown in the mobile drawer (and used to derive desktop grouping if ever needed). Omit for an ungrouped list. */
  label?: string;
  links: NavLink[];
}

/**
 * Role-appropriate primary navigation (DESIGN.md 2.4 "recognition over
 * recall" — never show a tab that just bounces the user to their own
 * dashboard). "Dashboard" always links to /dashboard, which redirects to the
 * signed-in user's own role dashboard (lib/auth.ts DASHBOARD_BY_ROLE) — this
 * table doesn't need to special-case that link's target per role.
 *
 * "Proctoring demo" is available to every signed-in role (legitimate
 * training/review surface — see app/proctor-demo/page.tsx's requireRole
 * call listing all four roles). It's appended after the role-specific
 * groups by getNavGroups below rather than duplicated in every entry.
 *
 * super_admin is the universal role (mirrors public.has_role() in SQL) and
 * gets every staff link, grouped so the mobile drawer stays scannable.
 */
const ROLE_NAV_GROUPS: Record<UserRole, NavGroup[]> = {
  student: [{ links: [{ href: "/dashboard", label: "Dashboard" }] }],
  lecturer: [
    {
      links: [
        { href: "/dashboard", label: "Dashboard" },
        { href: "/dashboard/lecturer/question-banks", label: "Question banks" },
        { href: "/dashboard/lecturer/exams", label: "Exams" },
        { href: "/dashboard/lecturer/classes", label: "Classes" },
        { href: "/dashboard/lecturer/forms-exams", label: "Forms quizzes" },
      ],
    },
  ],
  admin: [
    {
      links: [
        { href: "/dashboard", label: "Dashboard" },
        { href: "/dashboard/lecturer/classes", label: "Classes" },
        { href: "/dashboard/users", label: "Users & roles" },
        { href: "/dashboard/audit", label: "Audit log" },
      ],
    },
  ],
  super_admin: [
    // Unlabeled leading group so "Dashboard" renders as its own top-level
    // link (not buried inside the "Teaching" dropdown) — see DesktopNav,
    // which renders unlabeled groups inline and labeled groups as dropdowns.
    { links: [{ href: "/dashboard", label: "Dashboard" }] },
    {
      label: "Teaching",
      links: [
        { href: "/dashboard/lecturer/question-banks", label: "Question banks" },
        { href: "/dashboard/lecturer/exams", label: "Exams" },
        { href: "/dashboard/lecturer/classes", label: "Classes" },
        { href: "/dashboard/lecturer/forms-exams", label: "Forms quizzes" },
      ],
    },
    {
      label: "Administration",
      links: [
        { href: "/dashboard/users", label: "Users & roles" },
        { href: "/dashboard/audit", label: "Audit log" },
        { href: "/dashboard/system", label: "System overview" },
      ],
    },
  ],
};

const PROCTOR_DEMO_LINK: NavLink = { href: "/proctor-demo", label: "Proctoring demo" };

/**
 * Full nav structure for a signed-in role: role-specific groups plus the
 * shared "Proctoring demo" link in its own trailing group. Signed-out
 * callers should not use this — see getSignedOutLinks below.
 */
export function getNavGroups(role: UserRole): NavGroup[] {
  return [...ROLE_NAV_GROUPS[role], { links: [PROCTOR_DEMO_LINK] }];
}

/** Flat list variant of getNavGroups, for the desktop inline row which doesn't need group headings. */
export function getNavLinks(role: UserRole): NavLink[] {
  return getNavGroups(role).flatMap((group) => group.links);
}

/** Signed-out visitors get no app links in the header — just Home (the brand mark already links there) and Sign in, added separately by the caller. */
export const SIGNED_OUT_LINKS: NavLink[] = [];
