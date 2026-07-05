import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  ProctorLogResult,
  ProctorStorageAdapter,
  ProctorTransportAdapter,
  SnapshotMeta,
} from "@proctor/core";

import type { Database } from "@/lib/supabase/types";

/**
 * apps/web's implementations of proctor-core's two adapter interfaces.
 * proctor-core itself never imports @supabase/supabase-js — these adapters
 * are the only place Supabase-specific code touches the proctoring engine,
 * so swapping storage for Cloudflare R2 later (PLAN.md §1) means writing a
 * new ProctorStorageAdapter here, not touching packages/proctor-core.
 */

const PROCTORING_BUCKET = "proctoring";

export function createSupabaseTransportAdapter(
  supabase: SupabaseClient<Database>,
): ProctorTransportAdapter {
  return {
    async sendEvents(sessionId, events) {
      const { data, error } = await supabase.rpc("log_proctor_events", {
        session_id: sessionId,
        events:
          events as unknown as Database["public"]["Functions"]["log_proctor_events"]["Args"]["events"],
      });
      if (error) throw error;
      // Phase 1.5: log_proctor_events now returns { accepted, session_status,
      // violation_count, violation_limit } — the engine uses this to detect
      // server-side auto-termination without a second round-trip.
      return data as unknown as ProctorLogResult;
    },
  };
}

/**
 * LOCAL Supabase Storage for now (bucket 'proctoring', see
 * supabase/migrations/20260704000007_proctor_rls_and_storage.sql). To move
 * to Cloudflare R2 (10GB free, zero egress — PLAN.md §1): implement this
 * same interface against presigned R2 PUT URLs instead of
 * `supabase.storage.from(...).upload()`, and swap which adapter
 * `/proctor-demo` (and later the exam room) constructs. The engine and the
 * ProctorStorageAdapter *interface* never change.
 */
export function createSupabaseStorageAdapter(
  supabase: SupabaseClient<Database>,
): ProctorStorageAdapter {
  return {
    async uploadSnapshot(sessionId: string, blob: Blob, meta: SnapshotMeta) {
      const ext = meta.mimeType === "image/jpeg" ? "jpg" : "bin";
      const path = `${sessionId}/${Date.now()}.${ext}`;

      const { error: uploadError } = await supabase.storage
        .from(PROCTORING_BUCKET)
        .upload(path, blob, {
          contentType: meta.mimeType,
          upsert: false,
        });
      if (uploadError) throw uploadError;

      const { error: rpcError } = await supabase.rpc("record_proctor_media", {
        session_id: sessionId,
        storage_path: path,
        kind: "snapshot",
        captured_at: meta.capturedAt,
      });
      if (rpcError) throw rpcError;
    },
  };
}

/** Short-lived signed URL for displaying a snapshot thumbnail (private bucket — no public URL). */
export async function getSnapshotSignedUrl(
  supabase: SupabaseClient<Database>,
  storagePath: string,
  expiresInSeconds = 300,
): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from(PROCTORING_BUCKET)
    .createSignedUrl(storagePath, expiresInSeconds);
  if (error || !data) return null;
  return data.signedUrl;
}
