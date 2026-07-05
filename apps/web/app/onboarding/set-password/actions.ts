"use server";

import { revalidatePath } from "next/cache";

import { requireSignedIn } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export interface SetPasswordResult {
  error?: string;
}

const MIN_PASSWORD_LENGTH = 8;

/**
 * Phase 3a first-login password change. Requires only an authenticated
 * session (requireSignedIn — not requireRole, which would redirect a
 * must_change_password user right back to this same page). Updates the
 * user's own password via supabase.auth.updateUser() (the user's own
 * session token, not the service role — this endpoint runs as the user,
 * changing their own credential) then clears must_change_password via the
 * self-only clear_must_change_password() RPC.
 */
export async function setNewPassword(password: string, confirmPassword: string): Promise<SetPasswordResult> {
  await requireSignedIn();

  if (password.length < MIN_PASSWORD_LENGTH) {
    return { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  if (password !== confirmPassword) {
    return { error: "Passwords do not match." };
  }

  const supabase = await createClient();
  if (!supabase) {
    return { error: "Supabase is not configured in this environment." };
  }

  const { error: updateError } = await supabase.auth.updateUser({ password });
  if (updateError) {
    return { error: updateError.message };
  }

  const { error: clearError } = await supabase.rpc("clear_must_change_password");
  if (clearError) {
    return { error: clearError.message };
  }

  revalidatePath("/", "layout");
  return {};
}
