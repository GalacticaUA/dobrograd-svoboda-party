"use client";

/**
 * The one place a person's roles live in the browser.
 *
 * There are two surfaces that show roles — the admin panel's people table and the
 * portal's registry — and one place that changes them, the role editor's modal. The
 * brief is that a change made in the modal shows up in both, immediately, without a
 * reload. That cannot be done by each component keeping its own copy, because the
 * portal dialog lives in the root layout while the admin table lives inside the
 * admin page: they are different subtrees with no shared parent except the layout
 * itself. So the state lives here, at the layout, and both read from it.
 *
 * What is stored is deliberately thin: a SteamID, enough name to render, and the
 * roles. No contact details, no notes, no hours. Each surface seeds the store with
 * what it had already fetched — `listProfiles()` on /admin, `listRegistry()` in the
 * portal — and a person nobody has looked at is simply absent, which is exactly as
 * much as each surface already knew. That is why there is no loader in here: the
 * store never widens what a page can see, it only avoids two views of the same
 * person disagreeing.
 *
 * Mutations go through this module too rather than each component calling an action
 * of its own, because the interesting case is a transfer: adding `leader` to one
 * person removes it from another, in a different row of a different table. A
 * component that patched only its own row would be right about one row and wrong
 * about the other, and the reviewer would have to reload to find out.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  addableRolesFor,
  isAppointer,
  removableRolesFor,
  type PartyCounts,
} from "@/lib/permissions";
import { applyChange } from "@/lib/permissions";
import {
  grantMemberRole,
  revokeMemberRole,
  saveMemberRoles,
} from "@/lib/portal/actions";
import { normalizeRoles, type Role } from "@/types/party";
import type { ApprovalStatus } from "@/types/auth";
import { toast } from "sonner";

/** Enough of a person to draw a row and decide whether a role change is legal. */
export interface RoleHolder {
  steamId: string;
  displayName: string;
  persona: string;
  status: ApprovalStatus;
}

export interface HolderRoles extends RoleHolder {
  roles: readonly Role[];
}

export type StoreResult = { ok: true; roles: Role[] } | { ok: false; error: string };

interface RolesStoreValue {
  /** Everybody any surface has told us about, in no particular order. */
  holders: RoleHolder[];
  /** The roles of one person. `["member"]` for somebody the store has not seen. */
  rolesOf: (steamId: string) => Role[];
  /** Merge a freshly loaded list. Later calls win for the people they mention. */
  seed: (entries: readonly HolderRoles[]) => void;
  /** Record a confirmed change without calling the server. Never optimistic. */
  apply: (steamId: string, roles: readonly Role[]) => void;
  /** The party-wide numbers the role rules need. Derived, so they cannot go stale. */
  counts: PartyCounts;
  /** How many of `holders` currently hold this role. Drives the modal's columns. */
  holdersWith: (role: Role) => RoleHolder[];
  add: (steamId: string, role: Role) => Promise<StoreResult>;
  remove: (steamId: string, role: Role) => Promise<StoreResult>;
  replace: (steamId: string, roles: readonly Role[]) => Promise<StoreResult>;
  /** Whether the viewer may change this person's roles at all. */
  mayEdit: (steamId: string, viewerRoles: readonly Role[]) => boolean;
}

const RolesContext = createContext<RolesStoreValue | null>(null);

/**
 * Mounted once in the root layout. See the note at the top of the file for why it
 * is there and not inside /admin.
 */
export function RolesProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<Record<string, HolderRoles>>({});

  const holders = useMemo(
    () => Object.values(entries).map(({ steamId, displayName, persona, status }) => ({
      steamId,
      displayName,
      persona,
      status,
    })),
    [entries],
  );

  const roleMap = useMemo(() => {
    const map: Record<string, Role[]> = {};
    for (const [steamId, entry] of Object.entries(entries)) map[steamId] = entry.roles as Role[];
    return map;
  }, [entries]);

  const rolesOf = useCallback(
    (steamId: string) => normalizeRoles(roleMap[steamId] ?? []),
    [roleMap],
  );

  const apply = useCallback((steamId: string, roles: readonly Role[]) => {
    setEntries((previous) => {
      const known = previous[steamId];
      if (!known) return previous;
      return {
        ...previous,
        [steamId]: { ...known, roles: normalizeRoles(roles) },
      };
    });
  }, []);

  /**
   * `status` is carried on the entry rather than re-read, because a seed that
   * arrived from the portal has no reason to carry an admin's decision fields and
   * merging must not drop the fields a *previous* seed did carry.
   */
  const seed = useCallback((incoming: readonly HolderRoles[]) => {
    setEntries((previous) => {
      const next = { ...previous };
      let changed = false;

      for (const entry of incoming) {
        const roles = normalizeRoles(entry.roles);
        const existing = next[entry.steamId];
        if (
          existing &&
          existing.displayName === entry.displayName &&
          existing.persona === entry.persona &&
          existing.status === entry.status &&
          arraysEqual(existing.roles as Role[], roles)
        ) {
          continue;
        }
        next[entry.steamId] = { ...entry, roles };
        changed = true;
      }

      return changed ? next : previous;
    });
  }, []);

  /**
   * People who can appoint.
   *
   * Counted over `holders`, so it is only as complete as the roster the surfaces
   * have loaded. It is a hint for which options to draw, not the check — the DAL
   * recounts from the database and its answer wins. Counting here rather than
   * passing a number down is what keeps the two views of a transfer from
   * disagreeing about whether there is a second admin.
   */
  const counts = useMemo<PartyCounts>(
    () => ({
      topStandingCount: holders.filter(
        (holder) =>
          holder.status === "approved" && (roleMap[holder.steamId] ?? []).some(isAppointer),
      ).length,
    }),
    [holders, roleMap],
  );

  const holdersWith = useCallback(
    (role: Role) =>
      holders.filter((holder) => (roleMap[holder.steamId] ?? []).includes(role)),
    [holders, roleMap],
  );

  /**
   * Run a mutation, then record what the server says happened.
   *
   * The returned roles come from the action, not from what the caller hoped for.
   * That is the whole reason this is shared: a leader transfer changes two rows,
   * and only the server knows both. The local patch is applied afterwards and only
   * from its answer, so a refusal leaves the store exactly as it was.
   */
  const run = useCallback(
    async (
      pending: () => Promise<{ ok: true; data: Role[] } | { ok: false; error: string }>,
      after: (roles: Role[]) => void,
      quiet = false,
    ): Promise<StoreResult> => {
      const result = await pending();
      if (!result.ok) {
        if (!quiet) toast.error(result.error);
        return result;
      }

      // The action answers for the target. A transfer also changed somebody else,
      // and only they can be found by looking for the role that just left them.
      after(result.data);
      return { ok: true, roles: result.data };
    },
    [],
  );

  const add = useCallback(
    (steamId: string, role: Role) =>
      run(
        () => grantMemberRole(steamId, role),
        (roles) => {
          setEntries((previous) => {
            const next = { ...previous };
            if (next[steamId]) next[steamId] = { ...next[steamId], roles };

            // Somebody else just lost the leader title. Their entry is rewritten
            // here rather than left to a reload, which is the case the brief calls
            // out: the change has to be visible in the people table at once.
            if (role === "leader") {
              for (const [id, entry] of Object.entries(next)) {
                if (id === steamId) continue;
                if ((entry.roles as Role[]).includes("leader")) {
                  next[id] = { ...entry, roles: applyChange(entry.roles as Role[], { kind: "remove", role: "leader" }) };
                }
              }
            }

            return next;
          });
        },
      ),
    [run],
  );

  const remove = useCallback(
    (steamId: string, role: Role) =>
      run(
        () => revokeMemberRole(steamId, role),
        (roles) => apply(steamId, roles),
      ),
    [run, apply],
  );

  const replace = useCallback(
    (steamId: string, roles: readonly Role[]) =>
      run(
        () => saveMemberRoles({ steamId, roles }),
        (settled) => {
          // A `set` that includes `leader` demotes the previous holder just as an
          // `add` would, so the same sweep is done here.
          const takesLeader = settled.includes("leader");
          setEntries((previous) => {
            const next = { ...previous };
            if (next[steamId]) next[steamId] = { ...next[steamId], roles: settled };
            if (takesLeader) {
              for (const [id, entry] of Object.entries(next)) {
                if (id === steamId) continue;
                if ((entry.roles as Role[]).includes("leader")) {
                  next[id] = { ...entry, roles: applyChange(entry.roles as Role[], { kind: "remove", role: "leader" }) };
                }
              }
            }
            return next;
          });
        },
      ),
    [run],
  );

  const mayEdit = useCallback(
    // The only question this answers is "is the viewer somebody who appoints at
    // all". Which roles are legal for a *particular* person is asked separately, by
    // `useRoleOptions`, because that answer depends on the row.
    (steamId: string, viewerRoles: readonly Role[]) =>
      steamId.length > 0 && normalizeRoles(viewerRoles).some(isAppointer),
    [],
  );

  const value = useMemo<RolesStoreValue>(
    () => ({
      holders,
      rolesOf,
      seed,
      apply,
      counts,
      holdersWith,
      add,
      remove,
      replace,
      mayEdit,
    }),
    [holders, rolesOf, seed, apply, counts, holdersWith, add, remove, replace, mayEdit],
  );

  return <RolesContext.Provider value={value}>{children}</RolesContext.Provider>;
}

/** Null outside the provider, which is a wiring bug rather than a state to handle. */
export function useRolesStore(): RolesStoreValue {
  const store = useContext(RolesContext);
  if (!store) throw new Error("useRolesStore must be used inside <RolesProvider>");
  return store;
}

/** The options a role menu should draw, and the ones it must refuse to draw. */
export function useRoleOptions(viewerRoles: readonly Role[]) {
  const { counts, rolesOf } = useRolesStore();

  return useMemo(
    () => ({
      addable: (steamId: string) =>
        addableRolesFor({ actorRoles: viewerRoles, targetRoles: rolesOf(steamId), counts }),
      removable: (steamId: string) =>
        removableRolesFor({ actorRoles: viewerRoles, targetRoles: rolesOf(steamId), counts }),
    }),
    [viewerRoles, counts, rolesOf],
  );
}

function arraysEqual(a: readonly Role[], b: readonly Role[]): boolean {
  return a.length === b.length && a.every((role, index) => role === b[index]);
}
