/**
 * The built-in roles, highest standing first.
 *
 * `leader` and `admin` hold the same permissions — see `app/lib/permissions.ts`.
 * They are separate values because they are separate *jobs*, and the one place
 * they must be told apart is the role editor: an admin may not appoint another
 * admin or strip one, because the admin role is granted by hand in the database
 * rather than through this interface.
 *
 * `moderator` is what an admin used to be: the whole staff tier minus the power
 * to appoint.
 *
 * A person may hold SEVERAL of these at once, since 005. This type names the
 * values, not the cardinality: one person's roles are a `Role[]`, and the code
 * that holds a lone `Role` is the code that has not been converted yet.
 */
export type Role = "leader" | "admin" | "moderator" | "member";

/**
 * Every built-in role, as a runtime value.
 *
 * This exists for the same reason `ALL_ACTIONS` does in `app/lib/permissions.ts`.
 * The role reaches the session as a string inside a signed JWT, and it has to be
 * validated against a list; writing that list out by hand in the two places that
 * validate it means a new role compiles, passes every type check, and then locks
 * everybody holding it out of the site. One list, checked twice, cannot drift.
 *
 * Mirrors `public.party_role` in supabase/schema.sql.
 */
export const ROLES = ["leader", "admin", "moderator", "member"] as const satisfies readonly Role[];

/** Narrow an untrusted string to a `Role`, or `null` if it is not one. */
export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/**
 * The roles that are *appointed*, as opposed to `member`.
 *
 * `member` is the absence of the others rather than an appointment: membership of
 * the party is decided by `profiles.status`, and everybody approved is a member
 * whatever else they are. So it has no row in `profile_role_assignments`, and the
 * database refuses to store one. Every list here therefore contains at most three
 * values, and an empty list is a member.
 */
export const APPOINTMENT_ROLES = ["leader", "admin", "moderator"] as const satisfies readonly Role[];

/** True when this role is one that is stored rather than implied. */
export function isAppointment(role: Role): boolean {
  return role !== "member";
}

/**
 * Standing, lowest number wins. Used to order a display stack and to decide which
 * single role stands in for "the" role where one is still needed.
 *
 * Leader above admin, not because it is more powerful — they are equal, see the
 * note above — but because the title is the one worth putting first.
 */
const ROLE_RANK: Readonly<Record<Role, number>> = {
  leader: 1,
  admin: 2,
  moderator: 3,
  member: 4,
};

/** Highest standing first. The order every role stack is rendered in. */
export function sortRoles(roles: readonly Role[]): Role[] {
  return [...roles].sort((a, b) => ROLE_RANK[a] - ROLE_RANK[b]);
}

/**
 * The one role that speaks for this person, for code that still wants a scalar.
 *
 * There are deliberately few callers left. A badge list wants the whole set, and
 * the permission matrix wants the set too; this exists for the audit log's
 * `from`/`to` fields and for the single-value cache column.
 */
export function topRole(roles: readonly Role[]): Role {
  const sorted = sortRoles(roles.filter(isRole));
  return sorted[0] ?? "member";
}

/**
 * Coerce anything into a clean, sorted, duplicate-free role set.
 *
 * The input is untrusted on every path that matters: it comes out of a JWT, out of
 * PostgREST, or out of a client component that has been handed JSON. Unknown values
 * are dropped rather than passed through, so a role added to the database by
 * somebody who did not ship the code cannot reach a permission check as itself.
 *
 * `member` is dropped when anything else is present, and supplied when it is not,
 * so the set is either "the appointments" or exactly `["member"]` — never both,
 * which would render as a member who is also a moderator.
 */
export function normalizeRoles(value: unknown): Role[] {
  const seen = new Set<Role>();

  if (Array.isArray(value)) {
    for (const item of value) {
      if (isRole(item)) seen.add(item);
    }
  } else if (isRole(value)) {
    // A single value, which is what a token minted before 005 carries and what the
    // legacy `profiles.role` cache still holds.
    seen.add(value);
  }

  seen.delete("member");
  if (seen.size === 0) return ["member"];

  return sortRoles([...seen]);
}

/** True when this person holds this role. */
export function hasRole(roles: readonly Role[] | undefined, role: Role): boolean {
  return Array.isArray(roles) && roles.includes(role);
}

export type ApplicationStatus = "pending" | "approved" | "rejected";
export type ApplicationSource = "native" | "google";

export interface Member {
  id: string;
  username: string;
  nickname: string;
  discord: string;
  steamId: string;
  role: Role;
  hours: number;
  joinedAt: string;
}

export interface Application {
  id: string;
  source: ApplicationSource;
  name: string;
  email: string;
  phone: string;
  discord: string;
  steam: string;
  district: string;
  motivation: string;
  submittedAt: string;
  status: ApplicationStatus;
  notes: string;
}

export interface PartyEvent {
  id: string;
  title: string;
  date: string;
  time: string;
  location: string;
  hours: number;
  rsvps: string[];
  attended: string[];
}

export interface AvailabilitySlot {
  id: string;
  memberId: string;
  date: string;
  from: number;
  to: number;
}

export interface CmsContent {
  heroTitle: string;
  heroSubtitle: string;
  mission: string;
  transparencyTitle: string;
  transparencyText: string;
}

export interface NotificationPrefs {
  events: boolean;
  applications: boolean;
  news: boolean;
}
