import "server-only";

/**
 * Steam Web Authentication (OpenID 2.0) and Steam Web API identity lookup.
 *
 * This is a server-only module because the whole OpenID dance requires holding
 * the Steam Web API key, and because an assertion that is trusted in the
 * browser is not an assertion at all.
 *
 * The flow, and why each step exists:
 *
 *   1. Redirect the browser to Steam with openid.mode=checkid_setup.
 *   2. Steam redirects back to our return_to URL with the assertion in the
 *      query string. **At this point the assertion is worthless.** A visitor
 *      can hand-craft any callback URL, so `openid.claimed_id` is treated as
 *      untrusted input for the whole of this function.
 *   3. Re-verify by asking Steam directly: replay the received parameters back
 *      to Steam with openid.mode=check_authentication. Steam only answers
 *      `is_valid: true` for an assertion it actually issued. This is the step
 *      that makes the identity trustworthy, and skipping it is the single most
 *      common way an OpenID implementation is broken.
 *   4. Only then resolve the persona via the Web API.
 *
 * SteamID64 is a uint64. It exceeds Number.MAX_SAFE_INTEGER, so it must stay a
 * string end to end — never parseInt, never a numeric column, never arithmetic
 * in JavaScript. Base-account arithmetic is done with BigInt where needed.
 */

import { getSiteUrl, getSteamApiKey } from "@/lib/env";
import { isSteamId64, steamAvatarUrl, steamProfileUrl } from "@/lib/auth/profile";
import type { SteamIdentity } from "@/types/auth";

/** Steam Web Authentication endpoint. */
const OPENID_ENDPOINT = "https://steamcommunity.com/openid/login";

/** Steam Web API identity endpoint. */
const PLAYER_SUMMARIES_ENDPOINT =
  "https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/";

/**
 * Build the URL that starts sign-in.
 *
 * `return_to` must be an exact match of a URL Steam will redirect to, so it is
 * derived from a configured site origin rather than from a request header —
 * deriving it from the `Host` header would let an attacker point the
 * redirect at a host they control.
 */
export function buildSteamLoginUrl(returnTo?: string): string {
  const siteUrl = getSiteUrl();
  const params = new URLSearchParams({
    "openid.ns": "http://specs.openid.net/auth/2.0",
    "openid.mode": "checkid_setup",
    "openid.claimed_id": "http://specs.openid.net/auth/2.0/identifier_select",
    "openid.identity": "http://specs.openid.net/auth/2.0/identifier_select",
    "openid.realm": siteUrl,
    "openid.return_to": returnTo ?? `${siteUrl}/api/auth/steam/callback`,
  });

  return `${OPENID_ENDPOINT}?${params.toString()}`;
}

/**
 * Extract a SteamID64 from an `openid.claimed_id`.
 *
 * Returns null unless the identifier is an https URL on exactly
 * `steamcommunity.com` with the expected `/openid/id/<digits>` path. The host
 * check is the important half: without it, an `identifier_select` response
 * pointing at some other host could inject an arbitrary account id.
 */
export function parseClaimedId(claimedId: string | null): string | null {
  if (!claimedId) return null;

  let url: URL;
  try {
    url = new URL(claimedId);
  } catch {
    return null;
  }

  if (url.protocol !== "https:") return null;
  if (url.hostname !== "steamcommunity.com") return null;

  const match = /^\/openid\/id\/(\d+)$/.exec(url.pathname);
  if (!match) return null;

  const steamId = match[1];
  return isSteamId64(steamId) ? steamId : null;
}

/**
 * Step 3: replay the assertion to Steam and ask whether it is genuine.
 *
 * Every `openid.*` field received from the callback is forwarded back
 * unchanged, except `openid.mode`, which becomes `check_authentication`. Any
 * field we dropped or altered would make Steam reject a legitimate assertion.
 *
 * Returns the verified SteamID64, or null if the assertion is missing,
 * malformed, unverified, or not actually for Steam.
 */
export async function verifySteamAssertion(params: URLSearchParams): Promise<string | null> {
  const verified = params.get("openid.signed");
  const claimedId = params.get("openid.claimed_id");
  if (!verified || !claimedId) return null;

  // Cheap local checks first, so a junk callback never costs an outbound
  // request to Steam.
  const claimedSteamId = parseClaimedId(claimedId);
  if (!claimedSteamId) return null;

  const check = new URLSearchParams();
  for (const [key, value] of params) {
    if (key === "openid.mode" || key === "openid.ns") continue;
    check.set(key, value);
  }
  check.set("openid.mode", "check_authentication");
  check.set("openid.ns", "http://specs.openid.net/auth/2.0");

  let response: Response;
  try {
    response = await fetch(`${OPENID_ENDPOINT}?${check.toString()}`, {
      cache: "no-store",
      // OpenID verification is a POST-with-query-params call by spec; Next's
      // fetch does not follow redirects here, so Steam's answer is returned as
      // a plain text body.
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
  } catch {
    return null;
  }

  if (!response.ok) return null;

  // Steam answers `ns:http://is.gd/xsteam_2005,true` on success and
  // `ns:http://is.gd/xsteam_2005,false` on failure.
  const body = await response.text();
  if (!body.includes("is_valid:true")) return null;

  // Cross-check the replayed id against the one we will act on, so a valid
  // assertion for a different account cannot be substituted mid-flow.
  const verifiedClaim = parseClaimedId(params.get("openid.claimed_id"));
  if (verifiedClaim !== claimedSteamId) return null;

  return claimedSteamId;
}

/**
 * Step 4: resolve persona and avatar for an already-verified SteamID64.
 *
 * Only call this with an id that came out of verifySteamAssertion. It is not an
 * authorisation function: it will happily return data for any SteamID64 it is
 * given, so passing it user input would turn this into an open profile-enumeration
 * endpoint that burns the API key.
 */
export async function fetchSteamIdentity(steamId: string): Promise<SteamIdentity | null> {
  if (!isSteamId64(steamId)) return null;

  let payload: { response?: { players?: SteamApiPlayer[] } };
  try {
    // The key lookup is inside the try on purpose. `getSteamApiKey` throws when
    // STEAM_API_KEY is unset, and an unconfigured deployment must degrade to a
    // failed lookup — not to a 500 from a route handler, which tells the user
    // nothing they can act on.
    const url = new URL(PLAYER_SUMMARIES_ENDPOINT);
    url.searchParams.set("key", getSteamApiKey());
    url.searchParams.set("steamids", steamId);

    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) return null;
    payload = (await response.json()) as typeof payload;
  } catch {
    return null;
  }

  const player = payload.response?.players?.[0];
  if (!player) return null;

  return {
    steamId,
    persona: player.personaname ?? "",
    avatarUrl: player.avatarfull ?? player.avatarmedium ?? steamAvatarUrl(steamId),
    profileUrl: steamProfileUrl(steamId),
    // real_name is only returned to apps whose Steam Web API key is
    // authorised for it; it is usually absent, hence the null.
    realName: player.realname?.trim() ? player.realname : null,
  };
}

interface SteamApiPlayer {
  steamid: string;
  personaname?: string;
  avatarfull?: string;
  avatarmedium?: string;
  realname?: string;
}
