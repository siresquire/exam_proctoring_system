import { Fragment } from "react";
import Link from "next/link";

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

export interface BreadcrumbEntry {
  /** Visible label. Keep short — long labels truncate via CSS below. */
  label: string;
  /** Omit on the last entry: it renders as the non-interactive current page. */
  href?: string;
}

interface BreadcrumbsProps {
  items: BreadcrumbEntry[];
}

/**
 * Shared breadcrumb trail for every authenticated detail/sub page
 * (DESIGN.md 2.4 "recognition over recall" + 2.2 "user control & freedom" —
 * no detail page should be a dead end). Always starts implicitly from the
 * caller-supplied items; callers pass "Dashboard" as the first entry linking
 * to /dashboard, which redirects to the signed-in user's own role dashboard
 * (see lib/auth.ts DASHBOARD_BY_ROLE) so this one component works for every
 * role without needing to know which dashboard it is.
 *
 * The last item is rendered as the current page (aria-current="page", not a
 * link) per the shadcn/WAI-ARIA breadcrumb pattern. Each label truncates on
 * narrow viewports (375px) instead of wrapping the whole trail or
 * overflowing the container.
 */
export function Breadcrumbs({ items }: BreadcrumbsProps) {
  if (items.length === 0) return null;

  return (
    <Breadcrumb className="mb-4">
      <BreadcrumbList className="flex-nowrap overflow-x-auto">
        {items.map((item, index) => {
          const isLast = index === items.length - 1;
          return (
            <Fragment key={`${item.label}-${index}`}>
              {index > 0 ? <BreadcrumbSeparator /> : null}
              <BreadcrumbItem className="min-w-0">
                {isLast || !item.href ? (
                  <BreadcrumbPage className="block max-w-[16rem] truncate sm:max-w-xs">
                    {item.label}
                  </BreadcrumbPage>
                ) : (
                  <BreadcrumbLink asChild className="block max-w-[10rem] truncate sm:max-w-xs">
                    <Link href={item.href}>{item.label}</Link>
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
            </Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
