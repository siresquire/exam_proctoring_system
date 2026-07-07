"use server";

import { revalidatePath } from "next/cache";

import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { Json, UserRole } from "@/lib/supabase/types";

const USERS_PATH = "/dashboard/users";

export interface ActionResult {
  error?: string;
}

/**
 * Changes a user's role. Thin wrapper around the set_user_role RPC — every
 * escalation rule (nobody self-changes, only super_admin grants admin/
 * super_admin, admin may only set lecturer/student) is enforced in Postgres
 * (supabase/migrations/20260704000005_rls_policies.sql), NOT here. This
 * function exists only to run under requireRole and revalidate the page;
 * it never touches profiles.role directly.
 */
export async function changeUserRole(targetId: string, newRole: UserRole): Promise<ActionResult> {
  await requireRole("admin", "super_admin");

  const supabase = await createClient();
  if (!supabase) {
    return { error: "Supabase is not configured in this environment." };
  }

  const { error } = await supabase.rpc("set_user_role", { target: targetId, new_role: newRole });
  if (error) {
    return { error: error.message };
  }

  revalidatePath(USERS_PATH);
  return {};
}

export interface AccommodationsInput {
  extraTimeMultiplier: number | null;
  suppressAtFlags: boolean;
  notes: string;
}

/**
 * Updates a user's accommodations (DESIGN.md §3: extra-time multiplier,
 * AT-flag suppression, reviewer notes). Goes through the caller's own
 * authenticated client so RLS (profiles_update_admin_or_higher +
 * profiles_guard_update) is the actual enforcement: an admin/super_admin
 * may set accommodations on any row, but the same trigger still blocks
 * full_name/student_number/role from changing via this path.
 */
export async function updateAccommodations(
  targetId: string,
  input: AccommodationsInput,
): Promise<ActionResult> {
  await requireRole("admin", "super_admin");

  const supabase = await createClient();
  if (!supabase) {
    return { error: "Supabase is not configured in this environment." };
  }

  const accommodations: Json = {
    ...(input.extraTimeMultiplier !== null ? { extra_time_multiplier: input.extraTimeMultiplier } : {}),
    suppress_at_flags: input.suppressAtFlags,
    notes: input.notes.trim(),
  };

  const { error } = await supabase.from("profiles").update({ accommodations }).eq("id", targetId);
  if (error) {
    return { error: error.message };
  }

  revalidatePath(USERS_PATH);
  return {};
}
