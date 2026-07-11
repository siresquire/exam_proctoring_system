"use server";

import { randomUUID } from "node:crypto";

import { createClient } from "@/lib/supabase/server";
import { isR2Configured, presignR2Get, presignR2Put } from "@/lib/storage/r2";

/**
 * Server actions that presign R2 URLs for proctoring media (PLAN.md §1).
 * R2 has no RLS of its own — unlike the Supabase Storage path, where
 * `supabase/migrations/20260704000007_proctor_rls_and_storage.sql`'s bucket
 * policies are the actual security boundary, here THIS FILE is the entire
 * security boundary. Every function below re-derives the exact same
 * authorization those Postgres policies enforce, using the caller's
 * cookie-bound Supabase client (so RLS on `proctor_sessions` itself is
 * still a second, independent check underneath the explicit ones here).
 *
 * Both functions throw (rather than return null/false) on any
 * not-configured/not-authorized condition — callers (storage-adapter.ts)
 * are expected to only reach these when `NEXT_PUBLIC_STORAGE_PROVIDER`
 * has already selected "r2", so a throw here is always a real error, never
 * an expected branch.
 */

const EXT_PATTERN = /^[a-z0-9]{1,8}$/i;

export interface PresignedUpload {
  /** The R2 object key, generated here — never trust one from the caller. */
  key: string;
  /** Short-lived presigned PUT URL for this key. */
  url: string;
}

/**
 * Presigned PUT for a new piece of proctoring media (webcam snapshot or
 * identity portrait). Mirrors the storage RLS's INSERT policy
 * (`proctoring_insert_own_active_session`): the caller must own `sessionId`
 * AND that session must currently be `status = 'active'`. The returned key
 * is always `${sessionId}/${randomUUID()}.${ext}` — generated server-side,
 * enforcing the same `{session_id}/...` prefix the storage policy's
 * `(storage.foldername(name))[1]` check requires, so a forged key can never
 * land outside the caller's own session folder.
 */
export async function presignMediaUpload(
  sessionId: string,
  ext: string,
  contentType: string,
): Promise<PresignedUpload> {
  if (!isR2Configured()) throw new Error("R2 is not configured.");
  if (!EXT_PATTERN.test(ext)) throw new Error("Invalid file extension.");

  const supabase = await createClient();
  if (!supabase) throw new Error("Supabase is not configured.");

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in.");

  const { data: session, error } = await supabase
    .from("proctor_sessions")
    .select("user_id, status")
    .eq("id", sessionId)
    .maybeSingle();
  if (error) throw error;
  if (!session || session.user_id !== user.id || session.status !== "active") {
    // Same posture for "not found" and "not yours/not active": never leak
    // which case it was.
    throw new Error("Not authorized to upload media for this session.");
  }

  const key = `${sessionId}/${randomUUID()}.${ext}`;
  const url = await presignR2Put(key, contentType);
  return { key, url };
}

/**
 * Presigned GET for reading back one object. Mirrors the storage RLS's
 * SELECT policies combined (`proctoring_select_own` OR
 * `proctoring_select_lecturer_or_higher`): the caller must either own the
 * session the media belongs to, or hold the `lecturer` role (via the same
 * `has_role` RPC the SQL policies call — note `has_role('lecturer')` is an
 * EXACT role match plus super_admin's universal pass, not "admin or
 * higher"; mirrored here by calling the identical RPC rather than
 * re-implementing the rule).
 */
export async function presignMediaRead(storagePath: string): Promise<string> {
  if (!isR2Configured()) throw new Error("R2 is not configured.");

  const sessionId = storagePath.split("/")[0];
  if (!sessionId) throw new Error("Invalid storage path.");

  const supabase = await createClient();
  if (!supabase) throw new Error("Supabase is not configured.");

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in.");

  const [sessionResult, roleResult] = await Promise.all([
    supabase.from("proctor_sessions").select("user_id").eq("id", sessionId).maybeSingle(),
    supabase.rpc("has_role", { roles: ["lecturer"] }),
  ]);
  if (roleResult.error) throw roleResult.error;

  const isOwner = !sessionResult.error && sessionResult.data?.user_id === user.id;
  const isLecturerOrHigher = roleResult.data === true;
  if (!isOwner && !isLecturerOrHigher) {
    throw new Error("Not authorized to read this media.");
  }

  return presignR2Get(storagePath);
}
