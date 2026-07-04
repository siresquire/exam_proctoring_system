/**
 * Central place to read the public Supabase env vars, so every consumer
 * degrades gracefully when they're absent (e.g. CI builds and fresh
 * clones with no Supabase project yet) instead of crashing at import time.
 */

export interface SupabaseEnv {
  url: string;
  anonKey: string;
}

export function getSupabaseEnv(): SupabaseEnv | null {
  // NEXT_PUBLIC_* vars are inlined at build time, so these must be read as
  // direct property accesses (not dynamic lookups) for the client bundle.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  return { url, anonKey };
}

export function isSupabaseConfigured(): boolean {
  return getSupabaseEnv() !== null;
}
