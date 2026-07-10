"use client";

import * as React from "react";
import { LogOut } from "lucide-react";

import { signOut } from "@/app/auth/actions";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { UserRole } from "@/lib/supabase/types";

const ROLE_LABELS: Record<UserRole, string> = {
  super_admin: "Super Admin",
  admin: "Admin",
  lecturer: "Lecturer",
  student: "Student",
};

/** First + last initial from a full name, else the email's first letter, else "?". */
function getInitials(fullName: string | null, email: string | null): string {
  const name = (fullName ?? "").trim();
  if (name) {
    const parts = name.split(/\s+/);
    const first = parts[0]?.[0] ?? "";
    const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
    return (first + last).toUpperCase();
  }
  if (email) return email[0]!.toUpperCase();
  return "?";
}

export interface AccountMenuProps {
  role: UserRole;
  fullName: string | null;
  email: string | null;
}

/**
 * Compact account affordance for the top-right of the header: a circular
 * avatar button that opens a dropdown with the signed-in identity + sign
 * out. Replaces the old wide "name | role" pill so the primary nav has room
 * to lay out inline (the pill + the theme/text-size pills previously ate the
 * horizontal space the role links needed, forcing them to wrap into the
 * brand). Session comes in as props from the server (SiteHeader) — same
 * reasoning as the former UserMenu: no client-side session fetch, so the
 * Phase 1.6b refresh-race fix stays intact.
 */
export function AccountMenu({ role, fullName, email }: AccountMenuProps) {
  const [signingOut, setSigningOut] = React.useState(false);
  const displayName = fullName || email || "Signed in";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Account menu — ${displayName} (${ROLE_LABELS[role]})`}
          className="focus-visible:ring-ring/50 inline-flex size-11 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-3"
        >
          <Avatar className="size-9">
            <AvatarFallback className="bg-primary text-primary-foreground text-sm font-medium">
              {getInitials(fullName, email)}
            </AvatarFallback>
          </Avatar>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuLabel>
          <span className="text-foreground block truncate text-sm font-medium">{displayName}</span>
          {email ? (
            <span className="text-muted-foreground block truncate text-xs font-normal">{email}</span>
          ) : null}
          <Badge variant="secondary" className="mt-1">
            {ROLE_LABELS[role]}
          </Badge>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={signingOut}
          onSelect={() => {
            setSigningOut(true);
            // Server action clears the session cookie and redirects to /login.
            void signOut();
          }}
        >
          <LogOut aria-hidden="true" className="size-4" />
          {signingOut ? "Signing out…" : "Sign out"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
