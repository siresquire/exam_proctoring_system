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
import { createClient } from "@/lib/supabase/client";
import type { Profile, UserRole } from "@/lib/supabase/types";

const ROLE_LABELS: Record<UserRole, string> = {
  super_admin: "Super Admin",
  admin: "Admin",
  lecturer: "Lecturer",
  student: "Student",
};

/**
 * Signed-in user affordance in the site header: name, role badge, and
 * sign-out (server action). Renders nothing when signed out or when
 * Supabase isn't configured, so the header stays clean on public pages.
 */
export function UserMenu() {
  const [profile, setProfile] = React.useState<Profile | null>(null);
  const [email, setEmail] = React.useState<string | null>(null);
  const [signingOut, setSigningOut] = React.useState(false);

  React.useEffect(() => {
    const supabase = createClient();
    if (!supabase) return;
    // Non-null binding so the nested async closure keeps the narrowing.
    const client = supabase;

    let cancelled = false;

    async function load() {
      const {
        data: { user },
      } = await client.auth.getUser();
      if (cancelled) return;

      if (!user) {
        setProfile(null);
        setEmail(null);
        return;
      }

      setEmail(user.email ?? null);
      const { data } = await client.from("profiles").select("*").eq("id", user.id).single();
      if (!cancelled) setProfile(data ?? null);
    }

    void load();

    const {
      data: { subscription },
    } = client.auth.onAuthStateChange(() => {
      void load();
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, []);

  if (!profile) return null;

  const displayName = profile.full_name || email || "Signed in";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <UserRound aria-hidden="true" className="size-4" />
          <span className="max-w-40 truncate">{displayName}</span>
          <Badge variant="secondary">{ROLE_LABELS[profile.role]}</Badge>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuLabel>
          <span className="text-foreground block truncate text-sm font-medium">{displayName}</span>
          {email ? <span className="block truncate font-normal">{email}</span> : null}
          <span className="block font-normal">Role: {ROLE_LABELS[profile.role]}</span>
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
