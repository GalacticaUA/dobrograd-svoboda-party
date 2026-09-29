import { isAppointment, normalizeRoles, type Role } from "@/types/party";

/**
 * The permission vocabulary, and the baseline matrix that goes with it.
 *
 * A permission is a verb on a resource, not a role. `point.editAny` says "may
 * change anybody's point on the map"; `profile.setRole` says "may appoint
 * leaders". Roles are only ever names for bundles of these, and a role bundled
 * in the database adds to this matrix rather than replacing it — see
 * `app/lib/permissions/effective.ts` for how the two are combined.
 *
 * This module is deliberately client-safe: no `server-only`, no secrets, no
 * database. The same list is used to draw the role editor, to build the CHECK
 * constraint in supabase/migrations/003_custom_roles.sql, and to answer "may I"
 * on the client. Three places that must agree, which is why `ALL_ACTIONS` is
 * derived from the union rather than written out twice:
 *
 *   - server, authoritative  `assertCan` in app/lib/permissions/effective.ts,
 *     called by every DAL entry point. A Server Action is a POST endpoint anyone
 *     can call with a hand-written payload, so this is the real boundary.
 *   - client, advisory       `useCan()` in app/components/portal/permissions.tsx,
 *     which decides what to draw.
 *
 * A button that is visible but returns "недостаточно прав" is a cosmetic bug. A
 * button that is hidden but whose action still works is a security bug. Only the
 * second one matters, which is why the advisory check is never the only one.
 */

/**
 * Every permission the project knows about.
 *
 * The `Any` suffix is load-bearing and must not be dropped: it marks the
 * difference between "may touch this for anybody" and "may touch this only where
 * they are the author". `point.editAny` is a staff power; editing your own point
 * needs no `Any` at all, it falls out of `point.create` plus the row's
 * `created_by`. Without the distinction there is no way to grant a member the
 * right to fix their own typo on the map without also handing them the ability to
 * rewrite everybody else's.
 */
export type Action =
  // Обращения
  | "appeal.create"
  | "appeal.setStatus"
  | "appeal.reply"
  | "appeal.deleteOwn"
  | "appeal.deleteAny"
  // Опросы
  | "poll.create"
  | "poll.vote"
  | "poll.deleteOwn"
  | "poll.deleteAny"
  | "poll.close"
  // Мероприятия
  | "event.create"
  | "event.editAny"
  | "event.deleteAny"
  | "event.close"
  | "event.editHours"
  | "event.rsvp"
  // Карта работ
  | "point.create"
  | "point.editAny"
  | "point.deleteAny"
  // Профиль
  | "profile.editOwn"
  | "profile.editAny"
  | "profile.setRole"
  | "profile.grantRole"
  | "profile.remove"
  // Реестр
  | "registry.view"
  | "registry.editHours"
  // График доступности
  | "availability.editOwn"
  | "availability.viewAll"
  // Отчёты
  | "report.viewOwn"
  | "report.viewAll"
  // Заявки на вход
  | "application.review";

/**
 * Every permission as a runtime array, in one place.
 *
 * This is the single source for the role editor's checkboxes, for the validation
 * in the DAL, and for generating the migration's CHECK constraint. A hand-kept
 * list of the same 31 strings would be one forgotten line away from letting an
 * admin save a role the database then refuses.
 */
export const ALL_ACTIONS = [
  "appeal.create",
  "appeal.setStatus",
  "appeal.reply",
  "appeal.deleteOwn",
  "appeal.deleteAny",
  "poll.create",
  "poll.vote",
  "poll.deleteOwn",
  "poll.deleteAny",
  "poll.close",
  "event.create",
  "event.editAny",
  "event.deleteAny",
  "event.close",
  "event.editHours",
  "event.rsvp",
  "point.create",
  "point.editAny",
  "point.deleteAny",
  "profile.editOwn",
  "profile.editAny",
  "profile.setRole",
  "profile.grantRole",
  "profile.remove",
  "registry.view",
  "registry.editHours",
  "availability.editOwn",
  "availability.viewAll",
  "report.viewOwn",
  "report.viewAll",
  "application.review",
] as const satisfies readonly Action[];

/** Russian names, for the role editor. Never shown to members. */
export const ACTION_LABELS: Record<Action, string> = {
  "appeal.create": "Создавать обращения",
  "appeal.setStatus": "Менять статус обращений",
  "appeal.reply": "Отвечать на обращения",
  "appeal.deleteOwn": "Удалять свои обращения",
  "appeal.deleteAny": "Удалять любые обращения",
  "poll.create": "Создавать опросы",
  "poll.vote": "Голосовать",
  "poll.deleteOwn": "Удалять свои опросы",
  "poll.deleteAny": "Удалять любые опросы",
  "poll.close": "Закрывать опросы",
  "event.create": "Создавать мероприятия",
  "event.editAny": "Редактировать любые мероприятия",
  "event.deleteAny": "Удалять любые мероприятия",
  "event.close": "Закрывать мероприятия",
  "event.editHours": "Отмечать часы",
  "event.rsvp": "Записываться на мероприятия",
  "point.create": "Создавать точки на карте",
  "point.editAny": "Редактировать любые точки",
  "point.deleteAny": "Удалять любые точки",
  "profile.editOwn": "Редактировать свой профиль",
  "profile.editAny": "Редактировать чужие профили",
  "profile.setRole": "Назначать лидеров",
  "profile.grantRole": "Создавать и выдавать роли",
  "profile.remove": "Исключать участников",
  "registry.view": "Видеть реестр",
  "registry.editHours": "Править часы",
  "availability.editOwn": "Заполнять свой график",
  "availability.viewAll": "Видеть график всех",
  "report.viewOwn": "Видеть свои отчёты",
  "report.viewAll": "Видеть отчёты всех",
  "application.review": "Рассматривать заявки на вход",
};

/**
 * The role editor groups these rather than listing 31 checkboxes in a column.
 *
 * A permission whose label does not fit any group is still grantable — the
 * editor falls back to a leftover group — but a group with no members is not
 * rendered, so a refactor that empties one does not leave a dangling heading.
 */
export const ACTION_GROUPS: readonly { label: string; actions: readonly Action[] }[] = [
  {
    label: "Карта работ",
    actions: ["point.create", "point.editAny", "point.deleteAny"],
  },
  {
    label: "Мероприятия",
    actions: [
      "event.create",
      "event.editAny",
      "event.deleteAny",
      "event.close",
      "event.editHours",
      "event.rsvp",
    ],
  },
  {
    label: "Обращения",
    actions: [
      "appeal.create",
      "appeal.setStatus",
      "appeal.reply",
      "appeal.deleteOwn",
      "appeal.deleteAny",
    ],
  },
  {
    label: "Опросы",
    actions: ["poll.create", "poll.vote", "poll.deleteOwn", "poll.deleteAny", "poll.close"],
  },
  {
    label: "Реестр и отчёты",
    actions: [
      "registry.view",
      "registry.editHours",
      "report.viewOwn",
      "report.viewAll",
      "availability.editOwn",
      "availability.viewAll",
    ],
  },
  {
    label: "Люди",
    actions: [
      "profile.editOwn",
      "profile.editAny",
      "profile.setRole",
      "profile.grantRole",
      "profile.remove",
    ],
  },
  { label: "Заявки на вход", actions: ["application.review"] },
];

/**
 * Permissions that cannot be reached by granting a database role.
 *
 * Unreachable means exactly what it says: `assertCan` will not honour these from
 * `custom_role_permissions`, and the role editor will not offer them, whatever is
 * in the table. The built-in `profiles.role` column remains the only source.
 *
 * The reason is the obvious one and it is worth being explicit about, because
 * "give admins the ability to hand out roles" and "let admins hand out a role
 * containing the power to appoint leaders" are the same sentence read twice. A
 * custom role is a thing an admin can create and hand to people, so if
 * `profile.setRole` were grantable that way, an admin could write a role, award it
 * to themselves, and promote themselves to leader. The delegation stops here.
 *
 * `profile.grantRole` is grantable on purpose: an admin who may create roles
 * should be able to delegate the creation of *ordinary* roles, and this action
 * carries no authority beyond that.
 */
export const NON_DELEGABLE_ACTIONS: readonly Action[] = ["profile.setRole"];

export interface PermissionContext {
  /** True when the caller is the author/owner of the row being acted on. */
  isAuthor?: boolean;
}

/**
 * Everyone with any staff power: moderator, admin and leader alike.
 *
 * The tier exists so that "can this person touch anybody's stuff" is one question
 * with one answer, and so that adding a future role below admin is a change to
 * this array rather than to every call site that asks.
 */
const STAFF: readonly Role[] = ["leader", "admin", "moderator"];

/**
 * The two roles that may appoint and demote.
 *
 * `leader` and `admin` are equal in power, and deliberately so: the party does not
 * want a second tier of authority that only one person can reach, and an admin who
 * could not appoint anyone would be unable to do anything about a bad appointment.
 *
 * They are still separate *values*, because the role editor treats them
 * differently — see `canAssignRole`. `moderator` is absent, and that is the whole
 * difference between a moderator and an admin.
 */
export const LEADER_TIER: readonly Role[] = ["leader", "admin"];

/**
 * Actions available to every approved member, whatever their role.
 *
 * Membership of the party is decided by `profiles.status`, not by the role column,
 * which is why this list is keyed on nothing at all. `can("member", …)` and
 * `can("leader", …)` return the same answer for every action here, and that is
 * correct rather than an oversight.
 */
const ALL_MEMBERS: readonly Action[] = [
  "appeal.create",
  "appeal.setStatus",
  "appeal.deleteOwn",
  "poll.create",
  "poll.vote",
  "poll.deleteOwn",
  "event.rsvp",
  "profile.editOwn",
  "availability.editOwn",
  "report.viewOwn",
  "registry.view",
];

/** Actions reserved for the three staff roles: moderator, admin and leader. */
const STAFF_ACTIONS: readonly Action[] = [
  "appeal.reply",
  "appeal.deleteAny",
  "poll.deleteAny",
  "poll.close",
  "event.create",
  "event.editAny",
  "event.deleteAny",
  "event.close",
  "event.editHours",
  "point.create",
  "point.editAny",
  "point.deleteAny",
  "profile.editAny",
  "profile.grantRole",
  "profile.remove",
  "registry.editHours",
  "availability.viewAll",
  "report.viewAll",
  "application.review",
];

/**
 * Actions that appoint and demote — changing who outranks whom.
 *
 * Held by `LEADER_TIER`, so admin and leader both have it. `profile.remove` and
 * `profile.grantRole` are NOT here: expelling a member and delegating ordinary
 * roles hand nobody new authority over anybody, so all three staff roles may do
 * them.
 */
const LEADER_ACTIONS: readonly Action[] = ["profile.setRole"];

export function isStaff(role: Role): boolean {
  return STAFF.includes(role);
}

/**
 * Whether this role may appoint and demote.
 *
 * Named for the tier rather than the title, because `admin` and `leader` both
 * answer true and calling the function `isLeader` would quietly read as "leader
 * only" the next time somebody uses it.
 */
export function isAppointer(role: Role): boolean {
  return LEADER_TIER.includes(role);
}

/**
 * Whether this role is one of the two the party considers top standing.
 *
 * Same membership as `isAppointer` today, and that is not a coincidence: the
 * people who can appoint are the people whose loss would be noticed. The two names
 * are kept because they answer different questions — one is "may you appoint", the
 * other "would demoting this person empty the top of the party" — and the second
 * question is the one that has to stay readable if the first ever changes.
 */
export function isTopStanding(role: Role): boolean {
  return LEADER_TIER.includes(role);
}

/**
 * Baseline permissions for a built-in role, before any database role is added.
 *
 * Deliberately total and side-effect free: safe to call during render, and
 * identical in outcome to the old `can()`, which this replaced. It is the *base
 * layer* only — a member with a granted role holds the union of the two, and that
 * is computed in `effective.ts`, not here.
 *
 * This is the per-ROLE question. A person holds several roles, so anything asking
 * "may this person" wants `canAny` below rather than this.
 */
export function can(role: Role, action: Action, ctx: PermissionContext = {}): boolean {
  if (LEADER_ACTIONS.includes(action)) return isAppointer(role);

  // The own-vs-any pairs are the reason `ctx` exists. `isAuthor` alone is not
  // permission: the previous version returned `ctx.isAuthor === true` for any
  // role, including a role named in none of the lists, so every approved
  // member could delete their own open appeal by virtue of having signed in at
  // all. Own-ness is a precondition, not a grant — the action still has to be one
  // the role actually holds.
  if (action === "appeal.deleteOwn" || action === "poll.deleteOwn") {
    return ctx.isAuthor === true && ALL_MEMBERS.includes(action);
  }

  if (STAFF_ACTIONS.includes(action)) return isStaff(role);

  return ALL_MEMBERS.includes(action);
}

/**
 * May somebody holding ALL of these roles do this?
 *
 * The real question since 005: a person holds a *set* of roles, and the answer is
 * the union of what each would allow on its own. A moderator who is also an admin
 * is exactly as powerful as an admin, and the admin role is the one that says they
 * may appoint.
 *
 * This is the function every permission check should call. `can()` remains for the
 * per-role question — "what does the role `moderator` get" — which the role editor,
 * the tests and this file's own documentation ask. Handing `can()` a single role
 * where a person is meant is the mistake this exists to make impossible.
 *
 * An empty or absent set means member, which is the floor everybody stands on, so
 * a caller that forgot to pass the roles still gets a member rather than nobody.
 */
export function canAny(
  roles: readonly Role[] | undefined,
  action: Action,
  ctx: PermissionContext = {},
): boolean {
  return normalizeRoles(roles).some((role) => can(role, action, ctx));
}

/** The whole baseline for somebody holding all of these roles. */
export function baselineFor(roles: readonly Role[] | undefined): Action[] {
  return ALL_ACTIONS.filter((action) => canAny(roles, action));
}

/* -------------------------------------------------------------------------- */
/* Appointing: the role editor's rules                                           */
/* -------------------------------------------------------------------------- */

/**
 * The roles the role editor may hand out.
 *
 * `admin` is missing and cannot be added: the party grants it by hand in the
 * database, so it is deliberately not part of this interface. `member` is missing
 * for the opposite reason — it is the absence of the others, not an appointment,
 * and a person cannot be given back their own membership by an admin.
 */
export const ASSIGNABLE_ROLES: readonly Role[] = ["moderator", "leader"];

export type RoleChangeVerdict =
  | { ok: true }
  | { ok: false; reason: string; code: RoleChangeError };

export type RoleChangeError =
  | "not-permitted"
  | "not-appointable"
  | "assign-admin"
  | "remove-admin"
  | "last-top-standing";

/** One edit to somebody's role set. */
export type RoleChange =
  | { kind: "add"; role: Role }
  | { kind: "remove"; role: Role }
  | { kind: "set"; roles: readonly Role[] };

export interface PartyCounts {
  /** Approved people holding `leader` or `admin` — that is, who can appoint. */
  topStandingCount: number;
}

/**
 * May somebody holding `actorRoles` apply `change` to somebody holding `targetRoles`?
 *
 * The party's rules, as distinct from the permission matrix above. `profile.setRole`
 * answers "may this person appoint anybody at all"; this answers "and to whom, and
 * from whom". They are separate because the answers differ: a moderator cannot
 * appoint anybody, and an admin may appoint a leader but not an admin, and neither
 * of those follows from the matrix.
 *
 *   - `admin` is granted by hand in the database, never through this interface, so
 *     it can be neither given nor taken here. That is a statement about the role
 *     being outside the interface, not a power difference.
 *   - A leader is unique in the party, so adding `leader` is a *transfer*: it is
 *     always allowed, and the previous holder loses the role in the same
 *     transaction. There is deliberately no "a leader already exists" refusal any
 *     more — the party wants the title to move, not to be a wall.
 *   - A leader or an admin may be demoted by anybody who can appoint, including
 *     themselves. Stepping down is not a trap.
 *   - The one refusal about the party rather than about anybody's rights: the last
 *     person who can appoint may not be stripped of the ability, because the admin
 *     role is not grantable here and there would be no way back but SQL.
 *
 * `counts` is passed in rather than read here, which keeps this function free of
 * the database so the client can hide the impossible options and the DAL can
 * enforce the same answer from the authoritative numbers. The database enforces the
 * leader uniqueness itself; this is the layer that makes the UI honest about it.
 */
export function canChangeRoles(input: {
  actorRoles: readonly Role[] | undefined;
  targetRoles: readonly Role[] | undefined;
  change: RoleChange;
  counts: PartyCounts;
}): RoleChangeVerdict {
  if (!normalizeRoles(input.actorRoles).some(isAppointer)) {
    return { ok: false, code: "not-permitted", reason: "Назначать роли может только лидер или админ" };
  }

  const target = normalizeRoles(input.targetRoles);
  const touched = input.change.kind === "set" ? input.change.roles : [input.change.role];

  for (const role of touched) {
    if (!isAppointment(role)) {
      return {
        ok: false,
        code: "not-appointable",
        reason: "Роль «Участник» не назначается — это отсутствие других ролей",
      };
    }
  }

  /*
   * `admin` is outside this interface: the party grants it by hand in the
   * database, so no path through the role editor may hand it out or take it away.
   *
   * The question is whether *this change* grants or revokes admin, which is the
   * difference between the two states — not whether admin is in the result. A
   * result-only test is wrong in both directions: it refuses to save a person who
   * was made an admin by hand and is being given a moderator role on top (the
   * admin is untouched, so nothing is being handed out), and it refuses to let a
   * leader who is also an admin step down from the leadership alone (the admin
   * survives, so nothing is being taken away). Both of those are ordinary edits
   * somebody would want to make, and both would have been impossible.
   *
   * `set` is the verb the registry card submits, so it has to be judged the same
   * way: an `admin` in the new set that was not in the old one is a grant, and an
   * `admin` in the old one that is not in the new set is a revocation.
   */
  const result = applyChange(target, input.change);
  const heldAdmin = target.includes("admin");
  const keepsAdmin = result.includes("admin");

  if (keepsAdmin && !heldAdmin) {
    return { ok: false, code: "assign-admin", reason: "Роль админа выдаётся только напрямую в базе данных" };
  }

  if (heldAdmin && !keepsAdmin) {
    return { ok: false, code: "remove-admin", reason: "Роль админа снимается только напрямую в базе данных" };
  }

  // A verb that names admin at all is refused even when it is a no-op — removing
  // `admin` from somebody who never held it is a caller that has the wrong idea
  // about the data, and reporting success would hide that.
  if (input.change.kind === "add" && input.change.role === "admin") {
    return { ok: false, code: "assign-admin", reason: "Роль админа выдаётся только напрямую в базе данных" };
  }

  if (input.change.kind === "remove" && input.change.role === "admin") {
    return { ok: false, code: "remove-admin", reason: "Роль админа снимается только напрямую в базе данных" };
  }

  // Would this person still be able to appoint afterwards? If not, and nobody else
  // can, the party has just locked itself out of its own role editor.
  const stillAppointer = result.some(isAppointer);

  if (!stillAppointer && target.some(isAppointer) && input.counts.topStandingCount <= 1) {
    return { ok: false, code: "last-top-standing", reason: "Нельзя снять роль с последним лидером или админом" };
  }

  return { ok: true };
}

/** The role set that `change` would produce, without asking whether it is allowed. */
export function applyChange(targetRoles: readonly Role[] | undefined, change: RoleChange): Role[] {
  const current = normalizeRoles(targetRoles);

  if (change.kind === "set") return normalizeRoles(change.roles);

  const without = current.filter((role) => role !== change.role);
  if (change.kind === "remove") return normalizeRoles(without);

  return normalizeRoles([...without, change.role]);
}

/**
 * The roles that could be added to this person right now.
 *
 * Same answers as `canChangeRoles`, filtered rather than first-refused, so a menu
 * cannot present a choice the server would then reject. A role they already hold is
 * never offered, because adding it again is a no-op that would report success.
 */
export function addableRolesFor(input: {
  actorRoles: readonly Role[] | undefined;
  targetRoles: readonly Role[] | undefined;
  counts: PartyCounts;
}): Role[] {
  const held = normalizeRoles(input.targetRoles);
  return ASSIGNABLE_ROLES.filter(
    (role) => !held.includes(role) && canChangeRoles({ ...input, change: { kind: "add", role } }).ok,
  );
}

/**
 * The roles that could be taken away from this person right now.
 *
 * `admin` is absent by rule and `member` is absent because it was never held.
 */
export function removableRolesFor(input: {
  actorRoles: readonly Role[] | undefined;
  targetRoles: readonly Role[] | undefined;
  counts: PartyCounts;
}): Role[] {
  return normalizeRoles(input.targetRoles).filter(isAppointment).filter(
    (role) => canChangeRoles({ ...input, change: { kind: "remove", role } }).ok,
  );
}

/* -------------------------------------------------------------------------- */
/* Status transitions                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Which appeal statuses still count as "not yet handled", and therefore may
 * still be deleted by the member who wrote them.
 *
 * Once an appeal reaches `done` or `rejected` it becomes a record of a decision
 * the council actually took, and the author loses the ability to erase it.
 * Staff can always delete via `appeal.deleteAny`.
 */
export const APPEAL_OPEN_STATUSES = ["new", "in_review"] as const;
export type AppealOpenStatus = (typeof APPEAL_OPEN_STATUSES)[number];

export function isAppealOpen(status: string): status is AppealOpenStatus {
  return (APPEAL_OPEN_STATUSES as readonly string[]).includes(status);
}

/**
 * A poll stops accepting votes the moment it is closed, and a member may drop
 * their own poll only while it is still open.
 */
export function isPollOpen(status: string): boolean {
  return status === "open";
}
