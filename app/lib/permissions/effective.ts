import "server-only";

/**
 * Effective permissions: the built-in baseline plus whatever database roles the
 * caller holds.
 *
 * The two layers are combined here and nowhere else. `can()` in
 * `app/lib/permissions.ts` answers the static question "what does the role
 * `member` get", stays synchronous and client-safe, and is the whole of the
 * advisory layer. This file answers the real one, "what may *this person* do
 * right now", and is the only place that consults the database.
 *
 * `cache()` is what makes this affordable. Every DAL entry point needs at least
 * one check, a portal page makes several, and a request that saves a record
 * checks twice вЂ” the permission query, then the audit write. Without memoisation
 * that is several identical round trips per request. Wrapped, it is one.
 *
 * Not memoised across requests, deliberately. A revoked role takes effect on the
 * caller's next page load rather than whenever their 24-hour token happens to
 * expire, which is the same invariant the live role re-read in the auth DAL
 * exists to provide.
 */

import { cache } from "react";

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { SessionError } from "@/lib/auth/session-error";
import {
  ALL_ACTIONS,
  canAny as canBase,
  NON_DELEGABLE_ACTIONS,
  type Action,
  type PermissionContext,
} from "@/lib/permissions";
import type { ProfileDTO } from "@/types/auth";

/**
 * What these functions need to know about the caller: who they are, and what they
 * hold. Since 005 "what they hold" is a set, and a function typed on a single role
 * invites a call site that passes one role and silently answers for the wrong
 * person — a moderator who is also an admin would be judged as a moderator alone.
 */
type RoleHolder = Pick<ProfileDTO, "steamId" | "roles">;

const ALL_ACTION_SET: ReadonlySet<string> = new Set(ALL_ACTIONS);

/**
 * Actions a caller's granted roles add on top of the built-in role.
 *
 * A missing table is treated as "no custom roles" rather than as a hard failure.
 * That is not leniency, it is the deployment order: 003_custom_roles.sql has to
 * be applied by hand in the Supabase SQL editor, and until it is, every portal
 * page would otherwise 500 on a missing table. Degrading to the built-in
 * behaviour means the site keeps working with exactly the permissions it had
 * before, which is the correct blast radius for a missing feature table.
 *
 * The warning is not optional. Silently dropping a role grant is how somebody
 * spends an afternoon wondering why an admin can no longer edit the map.
 */
let warnedMissingRoleTables = false;

async function loadGrantedActions(steamId: string): Promise<Set<Action>> {
  const { data, error } = await getSupabaseAdmin()
    .from("profile_role_grants")
    // Through `custom_roles`, not straight to `custom_role_permissions`: the grant
    // table and the permission table are *siblings*, both holding a role_id, and
    // there is no foreign key between them. PostgREST can only embed along a real
    // relationship, so the direct hop is rejected with PGRST200.
    //
    // No spaces inside the parens. This PostgREST parses `a ( b ( c ) )` as
    // something else and answers PGRST100 "unexpected )"; the same query without
    // spaces is accepted. Verified against the live database.
    .select("custom_roles(custom_role_permissions(action))")
    .eq("steam_id", steamId);

  if (error) {
    const missingTable =
      error.code === "42P01" || error.code === "42703" || /does not exist/i.test(error.message ?? "");

    if (missingTable) {
      if (!warnedMissingRoleTables) {
        warnedMissingRoleTables = true;
        console.error(
          "[auth] custom role tables are not applied вЂ” running on built-in permissions only. Apply supabase/migrations/003_custom_roles.sql.",
          error.message,
        );
      }
      return new Set();
    }

    // A permission read that fails for any other reason is a real problem, and
    // failing closed is the only safe answer: if the grants cannot be read, the
    // person must not keep permissions nobody can currently justify.
    //
    // The fields are copied out rather than the error object passed through. A
    // PostgREST error carries `message`/`code` as non-enumerable properties, so
    // logging the object itself prints `{}` вЂ” which is exactly the useless output
    // that hid this bug the first time round.
    console.error(
      `[auth] failed to read role grants, denying custom permissions: ${error.code ?? "?"} ${error.message ?? "?"}`,
    );
    return new Set();
  }

  const granted = new Set<Action>();

  for (const row of (data ?? []) as unknown as Array<{ custom_roles: unknown }>) {
    // PostgREST returns an embedded relation as an object for a to-one join and
    // as an array otherwise; both shapes are handled rather than assuming,
    // because a wrong guess here reads as "no permissions" and quietly disables
    // the feature.
    const role = row.custom_roles;
    const roles = Array.isArray(role) ? role : role ? [role] : [];

    for (const item of roles) {
      const permissions = (item as { custom_role_permissions?: unknown } | null)?.custom_role_permissions;
      const list = Array.isArray(permissions) ? permissions : permissions ? [permissions] : [];

      for (const permission of list) {
        const action = (permission as { action?: string } | null)?.action;
        if (isGrantable(action)) granted.add(action);
      }
    }
  }

  return granted;
}

/**
 * Whether a stored action may be honoured when it comes from the database.
 *
 * `NON_DELEGABLE_ACTIONS` is filtered here rather than trusted. A role row can be
 * inserted by hand, or by a future bug, and the row that stops a privilege
 * escalation must not depend on the UI having offered the checkbox.
 */
export function isGrantable(action: unknown): action is Action {
  return (
    typeof action === "string" &&
    !NON_DELEGABLE_ACTIONS.includes(action as Action) &&
    ALL_ACTION_SET.has(action)
  );
}

/** Memoised per request. See the note at the top of the file. */
export const getGrantedActions = cache(async (steamId: string): Promise<Set<Action>> => {
  if (!steamId) return new Set();
  return loadGrantedActions(steamId);
});

/**
 * May this person do this, right now?
 *
 * The union of the built-in baseline and their granted roles. `ctx.isAuthor` is
 * passed through to the baseline unchanged: ownership is a fact about a row, not a
 * permission, and the same row is equally "theirs" under either layer.
 *
 * The baseline is asked about the whole set — `canAny`, not `can` on one role — so
 * somebody who is an admin *and* a moderator is judged as both. That is not
 * theoretical: the admin role is granted in the database, so in practice it sits on
 * top of whatever else the person already had, and judging them by the highest
 * role alone would be right only by accident.
 */
export async function canAct(
  profile: RoleHolder,
  action: Action,
  ctx: PermissionContext = {},
): Promise<boolean> {
  if (canBase(profile.roles, action, ctx)) return true;

  const granted = await getGrantedActions(profile.steamId);
  return granted.has(action);
}

/** The authoritative check. Every DAL entry point goes through this. */
export async function assertCan(
  profile: RoleHolder,
  action: Action,
  ctx: PermissionContext = {},
): Promise<void> {
  if (!(await canAct(profile, action, ctx))) {
    throw new SessionError("forbidden");
  }
}

/** Every permission this person currently holds, for the client. */
export async function getEffectivePermissions(profile: RoleHolder): Promise<Action[]> {
  const granted = await getGrantedActions(profile.steamId);
  const base = ALL_ACTIONS.filter((action) => canBase(profile.roles, action));
  return Array.from(new Set([...base, ...granted]));
}

/**
 * The permissions a caller is allowed to put into a role.
 *
 * This is the anti-escalation rule, and it is the whole reason a role editor
 * needs the server to be involved. "An admin may create and hand out roles" and
 * "an admin may hand out a role containing the power to appoint leaders" are the
 * same sentence read twice, and only the first was ever intended. So a role can
 * only contain permissions the person creating it already holds вЂ” which means an
 * admin can build anything up to admin and no further, and only a leader can
 * express a leader-level role.
 *
 * Note that this is a ceiling on what a role may *contain*, checked on write, and
 * separately `isGrantable` is a floor on what is *honoured* on read. Both are
 * needed: the first stops the mistake, the second stops the mistake being
 * exploitable if it happens anyway.
 */
export async function grantableActions(profile: RoleHolder): Promise<Action[]> {
  const effective = await getEffectivePermissions(profile);
  return effective.filter((action) => isGrantable(action));
}

/** True when every action in the list is one this person could grant. */
export async function canGrantAll(
  profile: RoleHolder,
  actions: readonly Action[],
): Promise<boolean> {
  const allowed = new Set(await grantableActions(profile));
  return actions.every((action) => allowed.has(action));
}
