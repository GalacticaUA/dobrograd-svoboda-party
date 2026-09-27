import type { Role } from "@/types/party";

/**
 * Single source of truth for portal permissions.
 *
 * This module is deliberately client-safe: no `server-only`, no secrets. The same
 * `can()` runs in two places, and they must never disagree —
 *
 *   Server Actions (authoritative)  re-check the live role before every write.
 *   Client components (advisory)     hide buttons the caller may not use.
 *
 * The asymmetry matters: the client check is a courtesy to the user, while the
 * server check is the actual boundary, because a Server Action is a POST
 * endpoint anyone can call with a hand-written payload. A button that is visible
 * but returns "недостаточно прав" is a cosmetic bug; a button that is hidden but
 * whose action still works is a security bug. Only the second one matters, which
 * is why every action in app/lib/portal/actions.ts calls `can()` itself.
 *
 * `ctx.isAuthor` carries the one piece of context `can()` cannot derive from the
 * role: whether the caller owns the row being acted on.
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
  // Мероприятия и расписание
  | "event.create"
  | "event.edit"
  | "event.close"
  | "event.editHours"
  | "event.rsvp"
  | "event.delete"
  // Карта работ
  | "point.create"
  | "point.edit"
  | "point.delete"
  // Профиль
  | "profile.editOwn"
  | "profile.editAny"
  | "profile.setRole"
  | "profile.remove"
  // Реестр
  | "registry.view"
  | "registry.editHours"
  // График доступности
  | "availability.editOwn"
  | "availability.viewAll"
  // Отчёты, реестр, заявки
  | "report.viewOwn"
  | "report.viewAll"
  | "registry.view"
  | "application.review";

export interface PermissionContext {
  /** True when the caller is the author/owner of the row being acted on. */
  isAuthor?: boolean;
}

const STAFF: readonly Role[] = ["leader", "admin"];

/** Actions available to every approved member, whatever their role. */
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

/** Actions reserved for admin and leader. */
const STAFF_ACTIONS: readonly Action[] = [
  "appeal.reply",
  "appeal.deleteAny",
  "poll.deleteAny",
  "poll.close",
  "event.create",
  "event.edit",
  "event.close",
  "event.editHours",
  "event.delete",
  "point.create",
  "point.edit",
  "point.delete",
  "profile.editAny",
  "profile.remove",
  "registry.editHours",
  "availability.viewAll",
  "report.viewAll",
  "application.review",
];

/**
 * Leader-only actions — changing who outranks whom.
 *
 * `profile.remove` is deliberately NOT one of these: expelling a member does not
 * hand anybody new authority over anybody, so both admin and leader may do it.
 * Only the appointment of leaders is leader-only.
 */
const LEADER_ACTIONS: readonly Action[] = ["profile.setRole"];

export function isStaff(role: Role): boolean {
  return STAFF.includes(role);
}

/**
 * Decide whether `role` may perform `action`.
 *
 * Deliberately total and side-effect free: it must stay safe to call from render.
 */
export function can(role: Role, action: Action, ctx: PermissionContext = {}): boolean {
  if (LEADER_ACTIONS.includes(action)) return role === "leader";

  if (STAFF_ACTIONS.includes(action)) return isStaff(role);

  if (action === "appeal.deleteOwn" || action === "poll.deleteOwn") {
    return ctx.isAuthor === true;
  }

  return ALL_MEMBERS.includes(action);
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
