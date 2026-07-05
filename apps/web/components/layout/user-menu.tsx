"use client";

import * as React from "react";
import { LogOut, UserRound } from "lucide-react";

import { signOut } from "@/app/auth/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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

export interface UserMenuProps {
  role: UserRole;
  fullName: string | null;
  email: string | null;
}

/**
 * Signed-in user affordance in the site header: name, role badge, and
 * sign-out (server action). Renders nothing when signed out or when
 * Supabase isn't configured, so the header stays clean on public pages.
 *
 * Takes the session as props from the server (`SiteHeader`, via
 * `getSessionProfile`) instead of fetching it itself. A prior version called
 * `supabase.auth.getUser()` from a browser-side `useEffect`, which spun up a
 * SECOND, independent GoTrue client next to the one the SSR middleware
 * (`lib/supabase/middleware.ts`) already runs on every request. When the
 * access token expired, both clients raced to redeem the same refresh token;
 * the loser got `Invalid Refresh Token: Already Used` from GoTrue's
 * reuse-detection, cleared its local session, and the next navigation's
 * `requireRole` server-side check saw a dead cookie and bounced to /login —
 * i.e. "logged out on refresh" even though the session was perfectly valid
 * seconds earlier. Server-only session resolution removes the race.
 */
export function UserMenu({ role, fullName, email }: UserMenuProps) {
  const [signingOut, setSigningOut] = React.useState(false);

  const displayName = fullName || email || "Signed in";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <UserRound aria-hidden="true" className="size-4" />
          <span className="max-w-40 truncate">{displayName}</span>
          <Badge variant="secondary">{ROLE_LABELS[role]}</Badge>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuLabel>
          <span className="text-foreground block truncate text-sm font-medium">{displayName}</span>
          {email ? <span className="block truncate font-normal">{email}</span> : null}
          <span className="block font-normal">Role: {ROLE_LABELS[role]}</span>
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
