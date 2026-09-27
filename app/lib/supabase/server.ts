import "server-only";

/**
 * Supabase client for privileged, server-side work.
 *
 * This module holds the service-role key, which bypasses Row Level Security.
 * That makes it the single most sensitive file in the repository, and it is
 * protected in three ways:
 *
 *   1. `import "server-only"` — a client-component import is a build error, not
 *      a silent runtime leak.
 *   2. The key is read through app/lib/env.ts and nowhere else.
 *   3. Every function that uses this client also calls requireRole() in
 *      app/lib/auth/dal.ts. The service role grants no authority on its own;
 *      the session check in the DAL is what authorises the call.
 *
 * The client is created lazily and memoised. Creating it at module scope would
 * make `next build` fail whenever the env vars are absent, breaking builds of
 * the public site that never touch the database.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { getSupabaseServiceRoleKey, getSupabaseUrl } from "@/lib/env";

let cached: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient {
  if (cached) return cached;

  cached = createClient(getSupabaseUrl(), getSupabaseServiceRoleKey(), {
    auth: {
      // The service role is a fixed credential with no user session behind it.
      // There is nothing to persist or refresh, and persisting it would write
      // the key into browser storage on any client that ever imported it.
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  return cached;
}
