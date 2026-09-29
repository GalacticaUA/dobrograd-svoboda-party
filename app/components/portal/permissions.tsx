"use client";

/**
 * The caller's effective permissions, resolved on the server.
 *
 * The portal used to pass the `role` down to every tab and ask the static
 * `can(role, action)` from `app/lib/permissions.ts`. That works only while the
 * role column is the whole truth, and it no longer is: a database role adds
 * permissions on top, and those live in tables the browser cannot read. So the
 * server resolves the union once, here, and the client is told the answer.
 *
 * `useCan` is deliberately a plain array lookup rather than a second call into
 * `can()`. Two implementations of "may I" that can disagree is the exact failure
 * this project already had once — the server keyed a registry check off
 * `report.viewAll` while the UI keyed it off `profile.setRole` — and the server
 * copy would be the authoritative one, leaving the UI quietly wrong instead of
 * loudly failing. A permission the client does not have is a missing button; the
 * server refusing the action is a real denial, and only the second is security.
 */

import { createContext, useContext, useMemo, type ReactNode } from "react";

import type { Action } from "@/lib/permissions";

/**
 * Empty rather than a fallback to the built-in role.
 *
 * A provider that guessed when it was missing would quietly grant exactly the
 * permissions an un-provisioned tree used to have, and the failure would surface
 * as "the button is there and the save fails". Failing closed makes the omission
 * visible as buttons nobody has, which is the recoverable version.
 */
const PermissionsContext = createContext<ReadonlySet<Action>>(new Set<Action>());

export function PermissionsProvider({
  permissions,
  children,
}: {
  permissions: readonly Action[];
  children: ReactNode;
}) {
  const value = useMemo(() => new Set<Action>(permissions), [permissions]);
  return <PermissionsContext.Provider value={value}>{children}</PermissionsContext.Provider>;
}

/** May I do this? Advisory: the server re-checks on every action. */
export function useCan(action: Action): boolean {
  return useContext(PermissionsContext).has(action);
}

/**
 * No `isAuthor` variant on purpose.
 *
 * Ownership is not part of the permission set — it is a fact about a row, and only
 * the component that already loaded that row knows it. So a tab holding an appeal
 * pairs `useCan("appeal.deleteAny")` with its own `isAuthor && isAppealOpen(row)`, in
 * that order, which is the same pair the DAL evaluates. A `useCan(action, own)`
 * helper would have to re-derive that pairing from the action name to be worth
 * anything, and then there would be two copies of the own/any rule to keep in step.
 */

export function usePermissions(): ReadonlySet<Action> {
  return useContext(PermissionsContext);
}
