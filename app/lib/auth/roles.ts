import "server-only";

/**
 * Reading a person's roles.
 *
 * Since 005 the roles live in `profile_role_assignments`, one row per role, and
 * `profiles.role` is a cache column a trigger maintains. Nothing in the application
 * writes that column any more, and nothing should read it as if it were the truth —
 * it can only hold the single highest-standing role, so somebody who is an admin
 * *and* a moderator is reported as just an admin. Every read goes through here,
 * against the rows.
 *
 * The helper is separate from `dal.ts` because several modules need it and
 * `dal.ts` is where permission checks live. This one does no authorisation: it
 * reads role sets for SteamIDs the caller has already been cleared for. Keeping
 * the split means a new caller cannot accidentally reach a raw assignment query
 * without going past the session check that sits next door.
 */

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { queryError } from "@/lib/supabase/errors";
import { normalizeRoles, type Role } from "@/types/party";

/**
 * Every role each of these people holds, keyed by SteamID.
 *
 * A single query for the whole set rather than one per person, so the people list
 * stays two round trips even with four hundred rows. A SteamID with no assignment
 * is absent from the map rather than mapped to an empty set, and callers use
 * `normalizeRoles(map.get(id) ?? [])`, which turns "absent" and "holds nothing" into
 * the same thing — `["member"]` — because to the party they are the same thing.
 */
export async function readRoleSets(steamIds: readonly string[]): Promise<Map<string, Role[]>> {
  const sets = new Map<string, Role[]>();
  if (steamIds.length === 0) return sets;

  const { data, error } = await getSupabaseAdmin()
    .from("profile_role_assignments")
    .select("steam_id, role")
    .in("steam_id", steamIds as string[]);

  if (error) {
    throw queryError("Failed to read role assignments", error);
  }

  for (const row of (data ?? []) as unknown as { steam_id: string; role: Role }[]) {
    const held = sets.get(row.steam_id);
    if (held) held.push(row.role);
    else sets.set(row.steam_id, [row.role]);
  }

  return sets;
}

/**
 * One person's roles, normalised.
 *
 * The single-person version of `readRoleSets`, for the session check and the role
 * editor's single-row reads. Still a query, not a read of the cache column: the
 * whole point of re-reading on each privileged action is that a promotion or a
 * revocation takes effect now rather than in 24 hours.
 */
export async function readRoleSet(steamId: string): Promise<Role[]> {
  const sets = await readRoleSets([steamId]);
  return normalizeRoles(sets.get(steamId) ?? []);
}

/**
 * How many approved people can appoint.
 *
 * The one party-wide number the role editor needs: it is what makes "you cannot
 * strip the last admin" a rule rather than a hope. Counted as *people* rather than
 * as rows, because somebody who is both leader and admin holds two rows and is
 * still one person who would be left with nothing — the same person counted twice
 * would let the editor take away both their roles in two steps.
 */
export async function countTopStanding(): Promise<number> {
  const { data, error } = await getSupabaseAdmin()
    .from("profile_role_assignments")
    .select("steam_id, role")
    .in("role", ["leader", "admin"]);

  if (error) throw queryError("Failed to count appointable members", error);

  const people = new Set<string>();
  for (const row of (data ?? []) as unknown as { steam_id: string; role: Role }[]) {
    // Only approved people count. A pending account somebody pre-assigned a role
    // to cannot appoint anybody, so it must not make the guard believe the party
    // has a second admin.
    people.add(row.steam_id);
  }

  if (people.size === 0) return 0;

  const { data: approved, error: statusError } = await getSupabaseAdmin()
    .from("profiles")
    .select("steam_id")
    .eq("status", "approved")
    .in("steam_id", [...people]);

  if (statusError) throw queryError("Failed to count appointable members", statusError);

  return (approved ?? []).length;
}
