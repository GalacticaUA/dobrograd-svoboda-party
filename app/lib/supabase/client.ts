/**
 * Supabase client for the browser. Public-key only.
 *
 * This deliberately holds nothing but `NEXT_PUBLIC_*` values, which Next inlines
 * into the client bundle at build time. The anon key is not a credential:
 * access is constrained by the RLS policies in supabase/schema.sql, which
 * deny every read of `profiles` and `join_applications`.
 *
 * Prefer reading published content with the server Supabase client where a
 * Server Component is enough, and use this only where genuinely interactive
 * client-side reads are required.
 *
 * Returns null when the project is not configured yet, so the public site keeps
 * rendering from its static data instead of crashing on a missing env var.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null | undefined;

export function getSupabaseBrowserClient(): SupabaseClient | null {
  if (cached !== undefined) return cached;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    cached = null;
    return cached;
  }

  cached = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return cached;
}
