import "server-only";

/**
 * Session token creation and verification.
 *
 * The brief asked for a client-side HMAC guard. This module implements the same
 * guarantee — an HMAC-SHA256 signature over the payload, a hard 24-hour expiry,
 * and re-verification before every privileged action — but signs and verifies
 * exclusively on the server, and stores the token in an httpOnly cookie.
 *
 * Why the two changes matter:
 *
 *   - A signature computed in the browser protects nothing. Verifying a
 *     signature requires the signing key, so the key must be in the JS bundle,
 *     and anyone with DevTools can read it and mint a token claiming
 *     `roles: ["leader"]` with a signature that validates. Here the key is read
 *     from `APP_SESSION_SECRET` on the server and is never shipped to a
 *     browser, so a forged token fails verification at the DAL.
 *
 *   - `sessionStorage` is readable by every script on the page, so one XSS is
 *     enough to exfiltrate the token. An httpOnly cookie is invisible to
 *     `document.cookie` and to `fetch`, which removes that whole class of leak.
 *
 * The token is a compact JWS: the payload is base64url and the HMAC is appended
 * by the library, so the "signature" field in the requested interface is the
 * token's own trailing segment rather than a duplicated field inside the body.
 */

import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";

import { getSessionSecret } from "@/lib/env";
import { isSteamId64 } from "@/lib/auth/profile";
import { SESSION_COOKIE_NAME, SESSION_MAX_AGE_MS } from "@/types/auth";
import type { ProfileDTO, SessionFailure, SessionPayload } from "@/types/auth";
import { normalizeRoles, isRole, topRole, type Role } from "@/types/party";

/** Stamped into every token so a token minted for another app is rejected. */
const ISSUER = "svoboda.party";
const AUDIENCE = "svoboda.party.portal";

function signingKey(): Uint8Array {
  return new TextEncoder().encode(getSessionSecret());
}

/**
 * Read the role set out of a verified payload, or `null` if it is not one.
 *
 * Two shapes are accepted. A token minted since 005 carries `roles`, an array. A
 * token minted before it carries a single `role`, and has to keep working for as
 * long as the 24-hour lifetime says it does — an upgrade that logged out every
 * signed-in moderator and admin would be a self-inflicted outage. A single valid
 * role is therefore read as a set of one.
 *
 * The check is strict: an array is only accepted when it is non-empty and every
 * element is a role this build knows. Anything else is `null`, which refuses the
 * token outright rather than quietly dropping the values it does not recognise.
 * That matters because a role somebody added in the database without shipping the
 * code would otherwise be silently discarded here, and the person holding it would
 * find themselves a member with no explanation.
 */
function readRoles(payload: Record<string, unknown>): Role[] | null {
  const { roles, role } = payload;

  if (Array.isArray(roles)) {
    if (roles.length === 0) return null;
    if (!roles.every(isRole)) return null;
    return normalizeRoles(roles);
  }

  // Pre-005 token.
  if (isRole(role)) return normalizeRoles(role);

  return null;
}

/**
 * Issue a session for a freshly verified profile and set the cookie.
 *
 * The expiry is absolute: `issuedAt + 24h`, never extended on use. A sliding
 * window would mean a session that is actively used never expires, which is
 * not the 24-hour guarantee the brief asks for. Staff re-authenticate daily.
 */
export async function createSession(profile: ProfileDTO): Promise<void> {
  const issuedAt = Date.now();
  const expiresAt = issuedAt + SESSION_MAX_AGE_MS;

  const token = await new SignJWT({
    steamId: profile.steamId,
    roles: profile.roles,
    role: profile.role,
    status: profile.status,
    issuedAt,
    expiresAt,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(profile.steamId)
    .setIssuedAt(Math.floor(issuedAt / 1000))
    // jose's `exp` is in seconds; the millisecond `expiresAt` above is the
    // value the application compares against Date.now().
    .setExpirationTime(Math.floor(expiresAt / 1000))
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .sign(signingKey());

  const cookieStore = await cookies();

  cookieStore.set(SESSION_COOKIE_NAME, token, {
    // Unreadable from document.cookie, so page scripts cannot exfiltrate it.
    httpOnly: true,
    // Sent over HTTPS only. Disabled in development because the local dev
    // server is plain http and the browser would drop the cookie entirely,
    // making the sign-in flow impossible to test.
    secure: process.env.NODE_ENV === "production",
    // Blocks cross-site POSTs, which is the main CSRF vector against the
    // approval and export actions.
    sameSite: "lax",
    path: "/",
    maxAge: Math.floor(SESSION_MAX_AGE_MS / 1000),
  });
}

/** Remove the session cookie. Safe to call when no session exists. */
export async function destroySession(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE_NAME);
}

/**
 * Verify a raw token and return its payload, or null if it is not usable.
 *
 * Checks performed, in order:
 *
 *   1. The HMAC-SHA256 signature, using a key only this server can read. This
 *      is what makes `role` unforgeable.
 *   2. The algorithm is pinned to HS256. Without this, a token could arrive
 *      declaring `alg: "none"` or an asymmetric algorithm and be accepted
 *      without any signature check at all — the classic JWT confusion attack.
 *   3. `exp`, then an explicit millisecond comparison, so a token is refused
 *      the instant it lapses rather than at the next clock tick.
 *   4. `expiresAt - issuedAt === 24h`, which rejects a hand-edited payload that
 *      somehow carried a valid length.
 *   5. Issuer and audience, so a token minted for another app on the same
 *      secret is not accepted here.
 */
export async function verifySessionToken(token: string | undefined): Promise<SessionPayload | null> {
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, signingKey(), {
      algorithms: ["HS256"],
      issuer: ISSUER,
      audience: AUDIENCE,
      // No grace period. The brief specifies a strict 24 hours.
      clockTolerance: 0,
    });

    const { steamId, status, issuedAt, expiresAt } = payload as Record<string, unknown>;

    if (typeof steamId !== "string" || !isSteamId64(steamId)) return null;
    if (typeof issuedAt !== "number" || typeof expiresAt !== "number") return null;
    // `readRoles`, not a hand-written list. The roles arrive from inside a signed
    // token, but they were written from database rows at some point in the past,
    // and a value this code does not recognise means the two have drifted — which
    // for a person who was just promoted to a new role means they cannot sign in
    // at all. The list lives in @/types/party, next to the enum it mirrors.
    const roles = readRoles(payload as Record<string, unknown>);
    if (!roles) return null;
    if (status !== "pending" && status !== "approved" && status !== "rejected") return null;

    if (expiresAt - issuedAt !== SESSION_MAX_AGE_MS) return null;
    if (Date.now() >= expiresAt) return null;

    return { steamId, roles, role: topRole(roles), status, issuedAt, expiresAt };
  } catch {
    // Expired, tampered, or malformed. Indistinguishable by design.
    return null;
  }
}

/**
 * Read and verify the session cookie for the current request.
 */
export async function getSessionPayload(): Promise<SessionPayload | null> {
  const cookieStore = await cookies();
  return verifySessionToken(cookieStore.get(SESSION_COOKIE_NAME)?.value);
}

/**
 * Verify a token and report *why* it failed, so the UI can tell a user that
 * their session lapsed after 24 hours rather than showing a generic error.
 *
 * This classification is for presentation only. Every branch returns the same
 * thing to the authorisation logic — no access — so a caller cannot accidentally
 * treat "expired" as a softer failure than "invalid signature".
 */
export async function inspectSessionToken(
  token: string | undefined,
): Promise<{ ok: true; payload: SessionPayload } | { ok: false; reason: SessionFailure }> {
  if (!token) return { ok: false, reason: "missing" };

  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(token, signingKey(), {
      algorithms: ["HS256"],
      issuer: ISSUER,
      audience: AUDIENCE,
      clockTolerance: 0,
    }));
  } catch (error) {
    // jose reports an expired token as `JWTExpired`; every other failure
    // (bad signature, wrong algorithm, malformed) is treated as "invalid".
    const code = (error as { code?: string }).code;
    return { ok: false, reason: code === "ERR_JWT_EXPIRED" ? "expired" : "invalid" };
  }

  const { steamId, status, issuedAt, expiresAt } = payload;

  if (typeof steamId !== "string" || !isSteamId64(steamId)) {
    return { ok: false, reason: "invalid" };
  }
  if (typeof issuedAt !== "number" || typeof expiresAt !== "number") {
    return { ok: false, reason: "invalid" };
  }
  const roles = readRoles(payload as Record<string, unknown>);
  if (!roles) {
    return { ok: false, reason: "invalid" };
  }
  if (status !== "pending" && status !== "approved" && status !== "rejected") {
    return { ok: false, reason: "invalid" };
  }
  if (expiresAt - issuedAt !== SESSION_MAX_AGE_MS) {
    return { ok: false, reason: "invalid" };
  }
  if (Date.now() >= expiresAt) {
    return { ok: false, reason: "expired" };
  }

  return {
    ok: true,
    payload: { steamId, roles, role: topRole(roles), status, issuedAt, expiresAt } as SessionPayload,
  };
}


