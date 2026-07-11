import { AwsClient } from "aws4fetch";

/**
 * Server-only Cloudflare R2 presigning (PLAN.md §1 — R2 as an optional,
 * env-gated backend for proctoring media). R2 is S3-compatible, so this
 * signs plain SigV4 presigned URLs with `aws4fetch` (no AWS SDK needed) —
 * see https://developers.cloudflare.com/r2/api/s3/presigned-urls/.
 *
 * The R2 secret key (`R2_SECRET_ACCESS_KEY`) never leaves this module: the
 * browser only ever receives a short-lived presigned URL, never the
 * credentials themselves. `assertServer()` below is a runtime guard mirroring
 * `lib/supabase/admin.ts`'s pattern (this repo doesn't otherwise depend on
 * the `server-only` package, so a runtime `typeof window` check gives the
 * same "throws loudly if ever bundled into client code" property without a
 * new dependency) — every exported function calls it before touching
 * `R2_SECRET_ACCESS_KEY`.
 *
 * Env-gated: all four `R2_*` vars must be present for `isR2Configured()` to
 * return true. Callers (storage-actions.ts) MUST check this before presigning
 * — with no R2 env set (the default/current production state), nothing in
 * this module is ever invoked.
 */

interface R2Env {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

function assertServer(): void {
  if (typeof window !== "undefined") {
    throw new Error("lib/storage/r2.ts must never be imported into browser code.");
  }
}

function readR2Env(): R2Env | null {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET;
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null;
  return { accountId, accessKeyId, secretAccessKey, bucket };
}

/** True only when all four `R2_*` server env vars are set. Safe to call from anywhere server-side (does not read the secret itself). */
export function isR2Configured(): boolean {
  return readR2Env() !== null;
}

function requireR2Env(): R2Env {
  assertServer();
  const env = readR2Env();
  if (!env) {
    throw new Error(
      "R2 is not configured (R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY/R2_BUCKET). Check isR2Configured() before calling this.",
    );
  }
  return env;
}

function objectUrl(env: R2Env, key: string): string {
  // key segments are generated/validated by storage-actions.ts (never raw
  // client input) — still percent-encode each segment defensively.
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  return `https://${env.accountId}.r2.cloudflarestorage.com/${env.bucket}/${encodedKey}`;
}

async function presign(
  env: R2Env,
  key: string,
  method: "PUT" | "GET",
  expiresSec: number,
  headers?: Record<string, string>,
): Promise<string> {
  const client = new AwsClient({
    accessKeyId: env.accessKeyId,
    secretAccessKey: env.secretAccessKey,
    service: "s3",
    region: "auto",
  });

  const url = new URL(objectUrl(env, key));
  url.searchParams.set("X-Amz-Expires", String(expiresSec));

  const signed = await client.sign(url.toString(), {
    method,
    headers,
    aws: { signQuery: true },
  });
  return signed.url;
}

/**
 * Presigned PUT URL for uploading one object to the private R2 bucket.
 * Binds `contentType` into the SigV4 signature (as a signed header) so the
 * URL can only be used to upload that exact content type — the browser
 * request must send a matching `content-type` header or R2 rejects it.
 * Default expiry 60s: the browser fetches this immediately after receiving
 * it, so a short window is enough and limits exposure if a URL leaks.
 */
export async function presignR2Put(
  key: string,
  contentType: string,
  expiresSec = 60,
): Promise<string> {
  const env = requireR2Env();
  return presign(env, key, "PUT", expiresSec, { "content-type": contentType });
}

/**
 * Presigned GET URL for reading back one object (snapshot/portrait
 * thumbnail). Default expiry 300s, matching `getSnapshotSignedUrl`'s
 * Supabase Storage equivalent (supabase-adapters.ts) — long enough to load
 * an `<img>` without needing a fresh URL per render, short enough that a
 * leaked URL doesn't stay valid long.
 */
export async function presignR2Get(key: string, expiresSec = 300): Promise<string> {
  const env = requireR2Env();
  return presign(env, key, "GET", expiresSec);
}
