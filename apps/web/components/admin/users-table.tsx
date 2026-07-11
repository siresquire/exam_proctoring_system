"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  MoreHorizontal,
  Search,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  Trash2,
  UserPlus,
  UserX,
} from "lucide-react";

import {
  changeUserRole,
  permanentlyDeleteAccount,
  setAccountStatus,
  updateAccommodations,
  type AccommodationsInput,
} from "@/app/dashboard/users/actions";
import { Breadcrumbs } from "@/components/layout/breadcrumbs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CreateUserDialog } from "@/components/admin/create-user-dialog";
import { notify } from "@/lib/notify";
import { ALL_ROLES, ROLE_LABELS, canActOnAccountRole } from "@/lib/admin/role-labels";
import type { AdminUserRow } from "@/lib/admin/users";
import type { ProfileStatus, UserRole } from "@/lib/supabase/types";

const ROLE_BADGE_VARIANT: Record<UserRole, "default" | "secondary" | "outline"> = {
  super_admin: "default",
  admin: "secondary",
  lecturer: "outline",
  student: "outline",
};

/**
 * Account-lifecycle status badge (DESIGN.md §1: "never conveyed by color
 * alone" — every state pairs a distinct icon with its own text label, not
 * just a color swap).
 */
function AccountStatusBadge({ status }: { status: ProfileStatus }) {
  if (status === "suspended") {
    return (
      <Badge variant="secondary">
        <ShieldOff aria-hidden className="size-3.5" />
        Suspended
      </Badge>
    );
  }
  if (status === "removed") {
    return (
      <Badge variant="destructive">
        <UserX aria-hidden className="size-3.5" />
        Removed
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-success border-success/40">
      <ShieldCheck aria-hidden className="size-3.5" />
      Active
    </Badge>
  );
}

interface UsersTableProps {
  users: AdminUserRow[];
  loadError?: string;
  currentUserId: string;
  viewerRole: UserRole;
}

/**
 * Which roles `viewerRole` is allowed to hand to `targetCurrentRole`,
 * mirroring set_user_role's escalation rules (supabase/migrations/
 * 20260704000005_rls_policies.sql) so the UI never offers a control the RPC
 * would reject. The RPC is still the actual enforcement — this is UX only.
 */
function assignableRoles(viewerRole: UserRole, targetCurrentRole: UserRole): UserRole[] {
  if (viewerRole === "super_admin") return ALL_ROLES;
  if (viewerRole === "admin") {
    // admin may only set lecturer/student, and only on targets that are
    // not themselves admin/super_admin.
    if (targetCurrentRole === "admin" || targetCurrentRole === "super_admin") return [];
    return ["lecturer", "student"];
  }
  return [];
}

export function UsersTable({ users, loadError, currentUserId, viewerRole }: UsersTableProps) {
  const router = useRouter();
  const [search, setSearch] = React.useState("");
  const [roleFilter, setRoleFilter] = React.useState<string>("all");
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [accommodationsTarget, setAccommodationsTarget] = React.useState<AdminUserRow | null>(null);
  const [createOpen, setCreateOpen] = React.useState(false);

  const filtered = React.useMemo(() => {
    return users.filter((u) => {
      if (roleFilter !== "all" && u.role !== roleFilter) return false;
      if (search.trim()) {
        const needle = search.trim().toLowerCase();
        const haystack = `${u.full_name ?? ""} ${u.email ?? ""} ${u.student_number ?? ""}`.toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    });
  }, [users, roleFilter, search]);

  async function handleRoleChange(user: AdminUserRow, newRole: UserRole) {
    if (newRole === user.role) return;

    const confirmed = await notify.confirm({
      title: `Change role to ${ROLE_LABELS[newRole]}?`,
      text: `${user.full_name ?? user.email ?? "This user"} will become ${ROLE_LABELS[newRole].toLowerCase()}. This takes effect immediately and is recorded in the audit log.`,
      confirmButtonText: "Change role",
      destructive: newRole === "admin" || newRole === "super_admin",
    });
    if (!confirmed) return;

    setBusyId(user.id);
    try {
      const result = await changeUserRole(user.id, newRole);
      if (result.error) {
        await notify.error("Could not change role", result.error);
        return;
      }
      await notify.toast({ title: `Role changed to ${ROLE_LABELS[newRole]}` });
      router.refresh();
    } finally {
      setBusyId(null);
    }
  }

  async function handleSetStatus(user: AdminUserRow, newStatus: ProfileStatus) {
    const name = user.full_name ?? user.email ?? "This account";
    const verb = newStatus === "active" ? "Reactivate" : newStatus === "suspended" ? "Suspend" : "Remove";
    const text =
      newStatus === "active"
        ? `${name} regains normal access immediately and can sign in again.`
        : newStatus === "suspended"
          ? `${name} is blocked from signing in until reactivated. This is reversible.`
          : `${name} is archived: blocked from signing in, but their records are kept. Reversible by reactivating later.`;

    const confirmed = await notify.confirm({
      title: `${verb} ${name}?`,
      text,
      confirmButtonText: verb,
      destructive: newStatus !== "active",
    });
    if (!confirmed) return;

    setBusyId(user.id);
    try {
      const result = await setAccountStatus(user.id, newStatus);
      if (result.error) {
        await notify.error(`Could not ${verb.toLowerCase()} account`, result.error);
        return;
      }
      await notify.toast({
        title: newStatus === "active" ? "Account reactivated" : newStatus === "suspended" ? "Account suspended" : "Account removed",
      });
      router.refresh();
    } finally {
      setBusyId(null);
    }
  }

  async function handlePermanentDelete(user: AdminUserRow) {
    const name = user.full_name ?? user.email ?? "this account";
    const confirmed = await notify.confirm({
      title: `Permanently delete ${name}?`,
      text: `This erases ${name}'s account entirely — including their exam attempts, proctoring sessions, and class enrollments. There is no undo.`,
      confirmButtonText: "Delete permanently",
      cancelButtonText: "Cancel",
      destructive: true,
    });
    if (!confirmed) return;

    setBusyId(user.id);
    try {
      const result = await permanentlyDeleteAccount(user.id);
      if (result.error) {
        await notify.error("Could not delete account", result.error);
        return;
      }
      await notify.toast({ title: "Account permanently deleted" });
      router.refresh();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <Breadcrumbs items={[{ label: "Dashboard", href: "/dashboard" }, { label: "Users & roles" }]} />
      <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Users & roles</h1>
          <p className="text-muted-foreground mt-2 max-w-2xl">
            Every account on the platform. Role changes are enforced server-side (nobody can change
            their own role; only a super admin can grant admin or super admin). Accommodations edits
            apply immediately.
          </p>
        </div>
        <Button type="button" onClick={() => setCreateOpen(true)} className="min-h-11">
          <UserPlus aria-hidden />
          Create user
        </Button>
      </header>

      {loadError ? (
        <Card className="border-destructive mb-6">
          <CardHeader>
            <CardTitle className="text-destructive flex items-center gap-2 text-base">
              <ShieldAlert aria-hidden className="size-4" />
              Could not load the full roster
            </CardTitle>
            <CardDescription>{loadError}</CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">All users</CardTitle>
          <CardDescription>{users.length} account{users.length === 1 ? "" : "s"} total.</CardDescription>
          <div className="grid gap-4 pt-2 sm:grid-cols-[1fr_12rem]">
            <div className="space-y-2">
              <Label htmlFor="user-search">Search</Label>
              <div className="relative">
                <Search aria-hidden className="text-muted-foreground absolute left-2.5 top-1/2 size-4 -translate-y-1/2" />
                <Input
                  id="user-search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Name, email, or index number"
                  className="min-h-11 pl-8"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="role-filter">Role</Label>
              <select
                id="role-filter"
                value={roleFilter}
                onChange={(e) => setRoleFilter(e.target.value)}
                className="border-input h-11 w-full rounded-lg border bg-transparent px-2.5 py-1 text-sm dark:bg-input/30"
              >
                <option value="all">All roles</option>
                {ALL_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {filtered.length === 0 ? (
            <p className="text-muted-foreground text-sm">No users match these filters.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableCaption className="sr-only">All platform users, their roles, and accommodations</TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">Name</TableHead>
                    <TableHead scope="col">Email</TableHead>
                    <TableHead scope="col">Index number</TableHead>
                    <TableHead scope="col">Role</TableHead>
                    <TableHead scope="col">Status</TableHead>
                    <TableHead scope="col" className="text-right">
                      Actions
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((user) => {
                    const options = assignableRoles(viewerRole, user.role);
                    const isSelf = user.id === currentUserId;
                    const canEditRole = !isSelf && options.length > 0;
                    const disabledReason = isSelf
                      ? "You cannot change your own role."
                      : options.length === 0
                        ? "Only a super admin can change an admin or super admin's role."
                        : null;
                    const canActOnAccount = !isSelf && canActOnAccountRole(viewerRole, user.role);
                    const name = user.full_name ?? user.email ?? "user";

                    return (
                      <TableRow key={user.id}>
                        <TableCell className="font-medium">{user.full_name ?? "—"}</TableCell>
                        <TableCell className="text-muted-foreground text-sm">{user.email ?? "—"}</TableCell>
                        <TableCell className="font-mono text-sm">{user.student_number ?? "—"}</TableCell>
                        <TableCell>
                          {canEditRole ? (
                            <select
                              aria-label={`Change role for ${user.full_name ?? user.email ?? "user"}`}
                              value={user.role}
                              disabled={busyId === user.id}
                              onChange={(e) => handleRoleChange(user, e.target.value as UserRole)}
                              className="border-input h-9 min-w-32 rounded-lg border bg-transparent px-2.5 py-1 text-sm dark:bg-input/30"
                            >
                              {/* Always include the current role even if it wouldn't otherwise be offered, so the select has a valid selected value. */}
                              {[user.role, ...options.filter((r) => r !== user.role)].map((r) => (
                                <option key={r} value={r}>
                                  {ROLE_LABELS[r]}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Badge variant={ROLE_BADGE_VARIANT[user.role]} tabIndex={0}>
                                    {ROLE_LABELS[user.role]}
                                  </Badge>
                                </TooltipTrigger>
                                <TooltipContent>{disabledReason ?? "Role editing is not available."}</TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col items-start gap-1">
                            <AccountStatusBadge status={user.status} />
                            {user.must_change_password ? (
                              <Badge variant="outline" className="text-xs">
                                Must set password
                              </Badge>
                            ) : null}
                          </div>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex flex-wrap justify-end gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setAccommodationsTarget(user)}
                            >
                              <Settings2 aria-hidden className="size-4" />
                              Accommodations
                            </Button>
                            {canActOnAccount ? (
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    disabled={busyId === user.id}
                                    aria-label={`Account actions for ${name}`}
                                  >
                                    <MoreHorizontal aria-hidden className="size-4" />
                                    Actions
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  {user.status !== "active" ? (
                                    <DropdownMenuItem onSelect={() => handleSetStatus(user, "active")}>
                                      <ShieldCheck aria-hidden />
                                      Reactivate
                                    </DropdownMenuItem>
                                  ) : null}
                                  {user.status === "active" ? (
                                    <DropdownMenuItem onSelect={() => handleSetStatus(user, "suspended")}>
                                      <ShieldOff aria-hidden />
                                      Suspend
                                    </DropdownMenuItem>
                                  ) : null}
                                  {user.status !== "removed" ? (
                                    <DropdownMenuItem
                                      variant="destructive"
                                      onSelect={() => handleSetStatus(user, "removed")}
                                    >
                                      <UserX aria-hidden />
                                      Remove (soft delete)
                                    </DropdownMenuItem>
                                  ) : null}
                                  {viewerRole === "super_admin" ? (
                                    <>
                                      <DropdownMenuSeparator />
                                      <DropdownMenuItem
                                        variant="destructive"
                                        onSelect={() => handlePermanentDelete(user)}
                                      >
                                        <Trash2 aria-hidden />
                                        Permanently delete
                                      </DropdownMenuItem>
                                    </>
                                  ) : null}
                                </DropdownMenuContent>
                              </DropdownMenu>
                            ) : null}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <AccommodationsDialog
        user={accommodationsTarget}
        onOpenChange={(open) => !open && setAccommodationsTarget(null)}
        onSaved={() => {
          setAccommodationsTarget(null);
          router.refresh();
        }}
      />

      <CreateUserDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        viewerRole={viewerRole}
        onCreated={() => router.refresh()}
      />
    </div>
  );
}

interface AccommodationsDialogProps {
  user: AdminUserRow | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

function AccommodationsDialog({ user, onOpenChange, onSaved }: AccommodationsDialogProps) {
  return (
    <Dialog open={user !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {user ? (
          // Keyed by user id so switching targets remounts this form with
          // fresh lazy-initialized state instead of syncing via an effect
          // (React's rules-of-hooks purity lint flags setState-in-effect;
          // this is the standard "reset state when the identity changes"
          // pattern instead).
          <AccommodationsForm key={user.id} user={user} onCancel={() => onOpenChange(false)} onSaved={onSaved} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function AccommodationsForm({
  user,
  onCancel,
  onSaved,
}: {
  user: AdminUserRow;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const initial = (user.accommodations ?? {}) as Record<string, unknown>;
  const [multiplier, setMultiplier] = React.useState(
    typeof initial.extra_time_multiplier === "number" ? String(initial.extra_time_multiplier) : "1",
  );
  const [suppressAtFlags, setSuppressAtFlags] = React.useState(Boolean(initial.suppress_at_flags));
  const [notes, setNotes] = React.useState(typeof initial.notes === "string" ? initial.notes : "");
  const [saving, setSaving] = React.useState(false);

  async function handleSave() {
    const parsedMultiplier = multiplier.trim() === "" ? null : Number(multiplier);
    if (parsedMultiplier !== null && (Number.isNaN(parsedMultiplier) || parsedMultiplier <= 0)) {
      await notify.warning("Invalid extra-time multiplier", "Enter a positive number, e.g. 1.25.");
      return;
    }

    const input: AccommodationsInput = {
      extraTimeMultiplier: parsedMultiplier,
      suppressAtFlags,
      notes,
    };

    setSaving(true);
    try {
      const result = await updateAccommodations(user.id, input);
      if (result.error) {
        await notify.error("Could not save accommodations", result.error);
        return;
      }
      await notify.success("Accommodations saved", "Changes apply to this student's next exam session.");
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Accommodations for {user.full_name ?? user.email ?? "user"}</DialogTitle>
        <DialogDescription>
          Extra time and assistive-technology flag suppression (DESIGN.md §3). Changes apply
          immediately and to future exam attempts.
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="extra-time">Extra-time multiplier</Label>
          <Input
            id="extra-time"
            value={multiplier}
            onChange={(e) => setMultiplier(e.target.value)}
            inputMode="decimal"
            placeholder="1.25"
            className="min-h-11"
            aria-describedby="extra-time-hint"
          />
          <p id="extra-time-hint" className="text-muted-foreground text-xs">
            e.g. 1.25, 1.5, or 2 for double time. Leave as 1 for no adjustment.
          </p>
        </div>
        <div className="flex items-start gap-3">
          <Checkbox
            id="suppress-at-flags"
            checked={suppressAtFlags}
            onCheckedChange={(checked) => setSuppressAtFlags(checked === true)}
          />
          <div className="grid gap-1">
            <Label htmlFor="suppress-at-flags">Suppress assistive-technology proctoring flags</Label>
            <p className="text-muted-foreground text-xs">
              Prevents blur/focus events from screen magnifiers or switch access being flagged as
              integrity violations for this student.
            </p>
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="accommodation-notes">Notes</Label>
          <textarea
            id="accommodation-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            maxLength={1000}
            placeholder="Context for reviewers (optional)"
            className="border-input focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30 w-full rounded-lg border bg-transparent px-2.5 py-2 text-sm outline-none transition-colors"
          />
        </div>
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" onClick={handleSave} disabled={saving}>
          {saving ? "Saving…" : "Save accommodations"}
        </Button>
      </DialogFooter>
    </>
  );
}
