/**
 * Steam identity constants and public URL builders.
 *
 * Deliberately NOT marked `server-only`, because the client needs to render a
 * link to a Steam profile. Nothing here touches a credential: both URLs are
 * served from Steam's public CDN and work without an API key.
 *
 * Kept separate from app/lib/auth/steam.ts, which is server-only because it
 * holds the OpenID exchange and the Web API key. Importing the URL builders
 * from a client component would correctly be a build error, so the shared,
 * harmless part lives here instead.
 */

/**
 * A SteamID64 is 17 digits: the fixed 7656119 prefix plus 10 more.
 *
 * It is a uint64 and exceeds JavaScript's safe-integer range, so it must remain
 * a string everywhere — never parseInt, never a numeric database column.
 */
export const STEAMID64_PATTERN = /^7656119\d{10}$/;

/** Type guard for a well-formed SteamID64. */
export function isSteamId64(value: unknown): value is string {
  return typeof value === "string" && STEAMID64_PATTERN.test(value);
}

/** Public Steam community profile. */
export function steamProfileUrl(steamId: string): string {
  return `https://steamcommunity.com/profiles/${steamId}`;
}

/** Public avatar CDN. No API key required, so safe to render in the browser. */
export function steamAvatarUrl(steamId: string): string {
  return `https://avatars.steamstatic.com/${steamId}_medium.jpg`;
}
