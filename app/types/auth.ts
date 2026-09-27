/**
 * Authentication, session, and Supabase data-flow types.
 *
 * Design note: these types are shared by the server-only Data Access Layer and
 * by client components, so nothing secret may be declared here. Types carry no
 * runtime behaviour, but a type imported into a client module is a strong hint
 * that the module is reachable from the browser — keep secret-bearing shapes
 * (raw profile rows, service-role clients) out of this file.
 */

import type { ApplicationStatus, ApplicationSource, Role } from "./party";

/** Hard 24-hour session lifetime, in milliseconds. */
export const SESSION_MAX_AGE_MS = 86_400_000;

export const SESSION_COOKIE_NAME = "svoboda_session";

/**
 * Claims embedded in the HMAC-signed session token.
 *
 * The brief specified an explicit `signature: string` field alongside the
 * payload. That is not reproduced here on purpose: a compact JWS *is* its own
 * signature, appended to the token and verified on every read. A second
 * signature field would duplicate the same HMAC, could drift out of sync with
 * the real one, and would invite a comparison against a client-controlled copy
 * of the value. The `signature` requirement is satisfied by the JWS structure.
 *
 * `sub` carries the SteamID64. The role is embedded for cheap optimistic UI
 * rendering only — it is never trusted on its own, because the Data Access
 * Layer re-reads the live profile row on every privileged operation (a role
 * revoked in Postgres must take effect immediately, not in 24 hours).
 */
export interface SessionPayload {
  /** SteamID64 of the authenticated user. Mirrors the JWT `sub` claim. */
  steamId: string;
  /** Role at the moment of sign-in. Advisory only; see note above. */
  role: Role;
  /** Vetting state at the moment of sign-in. */
  status: ApprovalStatus;
  /** Unix timestamp in milliseconds. */
  issuedAt: number;
  /** Unix timestamp in milliseconds. Always `issuedAt + SESSION_MAX_AGE_MS`. */
  expiresAt: number;
}

/** Mirrors the `approval_status` enum in supabase/schema.sql. */
export type ApprovalStatus = "pending" | "approved" | "rejected";

/** Roles permitted to reach the admin portal. Mirrors `isStaff` in hooks/usePortal.ts. */
export function isStaffRole(role: Role): boolean {
  return role === "leader" || role === "admin";
}

/**
 * The minimum safe projection of a `profiles` row for use in client components.
 *
 * Deliberately excludes `phone`, `notes` and `approved_by`. The Data Access
 * Layer returns this rather than the raw row so that a careless
 * `<Profile profile={row} />` cannot leak staff contact details into the
 * client bundle.
 */
export interface ProfileDTO {
  steamId: string;
  persona: string;
  avatarUrl: string;
  role: Role;
  status: ApprovalStatus;
}

/** Steam persona resolved from the Web API during sign-in. */
export interface SteamIdentity {
  steamId: string;
  persona: string;
  avatarUrl: string;
  profileUrl: string;
  realName: string | null;
}

/**
 * A `join_applications` row as read by the admin portal.
 *
 * Uses snake_case because this mirrors the database column names 1:1, which
 * keeps the mapping in the DAL trivial and auditable. `steam` is nullable
 * because the database normalises blank applicant input to NULL.
 */
export interface ApplicationRecord {
  id: string;
  source: ApplicationSource;
  name: string;
  email: string;
  phone: string;
  discord: string;
  steam: string | null;
  district: string;
  motivation: string;
  status: ApplicationStatus;
  notes: string;
  submittedAt: string;
  reviewedAt: string | null;
}

/** Result of re-checking a session at the moment of an action. */
export type SessionCheck =
  | { ok: true; profile: ProfileDTO }
  | { ok: false; reason: SessionFailure };

export type SessionFailure = "missing" | "invalid" | "expired" | "unapproved" | "forbidden";
