import type { SupabaseClient } from "@supabase/supabase-js";
import type { ProctorStorageAdapter, SnapshotMeta } from "@proctor/core";

import type { Database } from "@/lib/supabase/types";
import {
  createSupabaseStorageAdapter,
  getSnapshotSignedUrl,
} from "@/lib/proctor/supabase-adapters";
import { presignMediaRead, presignMediaUpload } from "@/lib/proctor/storage-actions";

/**
 * Provider-agnostic storage layer (PLAN.md §1): Supabase Storage stays the
 * default, unchanged behavior; Cloudflare R2 is an opt-in alternative
 * selected by a single **public, non-secret** flag —
 * `NEXT_PUBLIC_STORAGE_PROVIDER`. This flag only picks which upload/read
 * path runs; it never carries a credential (the R2 secret lives exclusively
 * server-side in lib/storage/r2.ts, reached only through the "use server"
 * actions in storage-actions.ts). With the env var unset (the current/live
 * pilot state), `getStorageProvider()` returns "supabase" and every
 * function here is byte-for-byte the existing Supabase Storage path.
 */
export type StorageProvider = "supabase" | "r2";

export function getStorageProvider(): StorageProvider {
  return process.env.NEXT_PUBLIC_STORAGE_PROVIDER === "r2" ? "r2" : "supabase";
}

/**
 * Builds the `ProctorStorageAdapter` proctor-core expects, wired to
 * whichever provider is active. `provider` defaults to `getStorageProvider()`
 * but can be passed explicitly (e.g. tests). The R2 branch never touches
 * Supabase Storage; the default branch is exactly `createSupabaseStorageAdapter`
 * from supabase-adapters.ts, unchanged.
 */
export function createProctorStorageAdapter(
  supabase: SupabaseClient<Database>,
  provider: StorageProvider = getStorageProvider(),
): ProctorStorageAdapter {
  if (provider !== "r2") {
    return createSupabaseStorageAdapter(supabase);
  }

  return {
    async uploadSnapshot(sessionId: string, blob: Blob, meta: SnapshotMeta) {
      const ext = meta.mimeType === "image/jpeg" ? "jpg" : "bin";
      const { key, url } = await presignMediaUpload(sessionId, ext, meta.mimeType);

      const res = await fetch(url, {
        method: "PUT",
        body: blob,
        headers: { "content-type": meta.mimeType },
      });
      if (!res.ok) {
        throw new Error(`R2 snapshot upload failed: ${res.status} ${res.statusText}`);
      }

      // Same RPC as the Supabase path, unchanged — record_proctor_media
      // just stores whichever storage_path it's given, provider-agnostic.
      const { error: rpcError } = await supabase.rpc("record_proctor_media", {
        session_id: sessionId,
        storage_path: key,
        kind: "snapshot",
        captured_at: meta.capturedAt,
      });
      if (rpcError) throw rpcError;
    },
  };
}

/**
 * Uploads the one-shot identity portrait (Phase 1.5) through whichever
 * provider is active, returning the `storage_path` to pass to
 * `attach_identity_portrait` — unchanged, provider-agnostic RPC. Used by
 * both `proctor-demo.tsx` and `forms-exam-wrapper.tsx` in place of each
 * inlining its own `supabase.storage.from('proctoring').upload(...)` call.
 */
export async function uploadIdentityPortrait(
  supabase: SupabaseClient<Database>,
  sessionId: string,
  blob: Blob,
  provider: StorageProvider = getStorageProvider(),
): Promise<string> {
  if (provider === "r2") {
    const { key, url } = await presignMediaUpload(sessionId, "jpg", "image/jpeg");
    const res = await fetch(url, {
      method: "PUT",
      body: blob,
      headers: { "content-type": "image/jpeg" },
    });
    if (!res.ok) {
      throw new Error(`R2 identity portrait upload failed: ${res.status} ${res.statusText}`);
    }
    return key;
  }

  // Existing Supabase path (byte-for-byte what proctor-demo.tsx/
  // forms-exam-wrapper.tsx did inline before this factory existed) — storage
  // RLS requires the `{session_id}/...` prefix for an active session owned
  // by the caller, same as uploadSnapshot.
  const path = `${sessionId}/identity-${Date.now()}.jpg`;
  const { error } = await supabase.storage
    .from("proctoring")
    .upload(path, blob, { contentType: "image/jpeg", upsert: false });
  if (error) throw error;
  return path;
}

/**
 * Short-lived read URL for displaying a snapshot/portrait thumbnail,
 * routed to whichever provider is active. R2 branch re-derives the
 * owner-or-lecturer authorization server-side (presignMediaRead) since R2
 * has no RLS; the default branch is exactly `getSnapshotSignedUrl`,
 * unchanged (Supabase Storage RLS is still the enforcement there).
 */
export async function getProctorMediaUrl(
  supabase: SupabaseClient<Database>,
  storagePath: string,
  provider: StorageProvider = getStorageProvider(),
): Promise<string | null> {
  if (provider === "r2") {
    try {
      return await presignMediaRead(storagePath);
    } catch (err) {
      console.error("presignMediaRead failed", err);
      return null;
    }
  }
  return getSnapshotSignedUrl(supabase, storagePath);
}
