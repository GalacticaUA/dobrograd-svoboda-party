import "server-only";

/**
 * Server-only environment access.
 *
 * Every secret in the project is read through this module and nowhere else, so
 * there is exactly one file to audit when adding or rotating a credential.
 * Keeping the reads here also means no secret can leak into a client module by
 * accident — the `server-only` import at the top makes such a mistake a build
 * error rather than a runtime leak.
 *
 * Values are resolved lazily on first access. Throwing at module scope would
 * break `next build` for the whole site, including the public pages that need
 * no database at all, whenever Supabase has not been configured yet.
 */

/** Non-null env reader. Call only once the caller has handled the null case. */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        `Copy .env.local.example to .env.local and fill it in.`,
    );
  }
  return value;
}

export function getSupabaseUrl(): string {
  return requireEnv("NEXT_PUBLIC_SUPABASE_URL");
}

export function getSupabaseAnonKey(): string {
  return requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
}

/**
 * The service-role key. This bypasses Row Level Security completely, so it is
 * reachable only from modules marked `server-only`.
 */
export function getSupabaseServiceRoleKey(): string {
  return requireEnv("SUPABASE_SERVICE_ROLE_KEY");
}

/** Steam Web API key. Server-only: exposing it allows profile enumeration. */
export function getSteamApiKey(): string {
  return requireEnv("STEAM_API_KEY");
}

/**
 * HMAC key for the session token. Rotating this invalidates every active
 * session, which is the correct response to a suspected compromise.
 */
export function getSessionSecret(): string {
  return requireEnv("APP_SESSION_SECRET");
}

/**
 * Public origin, used to build the Steam OpenID `return_to` parameter. Steam
 * requires an exact match, so this must carry no trailing slash.
 */
export function getSiteUrl(): string {
  const url = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  return url.replace(/\/+$/, "");
}

/** True when the database is configured, so public pages can degrade gracefully. */
export function isSupabaseConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}

/** True when the Steam Web API key is present. */
export function isSteamConfigured(): boolean {
  return Boolean(process.env.STEAM_API_KEY);
}

/** True when the session signing key is present. */
export function isSessionConfigured(): boolean {
  return Boolean(process.env.APP_SESSION_SECRET);
}

/**
 * Names of the variables the sign-in flow needs but does not have.
 *
 * This exists so an unconfigured deployment can be diagnosed from the browser
 * instead of from a stack trace. `requireEnv` throws, which is the right
 * behaviour for a secret that has already been checked for — but when nothing
 * is configured at all the throw escapes a route handler and the user gets a
 * bare 500. The auth routes call this first and redirect to a readable message
 * instead, and the same list is rendered by the header notice.
 *
 * Names only, never values.
 */
export function missingAuthEnv(): string[] {
  const required: Array<[string, string]> = [
    ["NEXT_PUBLIC_SUPABASE_URL", "Supabase project URL"],
    ["NEXT_PUBLIC_SUPABASE_ANON_KEY", "Supabase anon key"],
    ["SUPABASE_SERVICE_ROLE_KEY", "Supabase service-role key"],
    ["STEAM_API_KEY", "Steam Web API key"],
    ["APP_SESSION_SECRET", "session signing secret"],
  ];

  return required.filter(([name]) => !process.env[name]).map(([name, label]) => `${name} (${label})`);
}
