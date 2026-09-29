/**
 * Role names, in one place.
 *
 * There were four copies of this map — the people table, the auth dialog, the
 * registry tab and the CSV writer — and a fifth would have been written for the
 * role editor. They drifted before: the registry gained `moderator` while the CSV
 * still exported the old three, so the same person was "Админ" on screen and
 * "admin" in the spreadsheet. A label is data, and data with four copies is data
 * that will be wrong in one of them.
 *
 * Client-safe: no `server-only` import, so a Server Component may read it too.
 */

import type { Role } from "@/types/party";

/** The badge and dropdown text for each built-in role. */
export const ROLE_LABEL: Record<Role, string> = {
  leader: "Лидер",
  admin: "Админ",
  moderator: "Модератор",
  member: "Участник",
};

/**
 * What each role actually gets, in a reviewer's words.
 *
 * Rendered as the `title` on a badge, so a member who was told "назначь
 * модератора" and does not know what that is can hover instead of asking. Kept
 * short on purpose: it has to survive a `title` tooltip.
 */
export const ROLE_MEANING: Record<Role, string> = {
  leader: "может назначать и снимать роли, как и админ",
  admin: "то же, что лидер; выдаётся только напрямую в базе данных",
  moderator: "старые права админа, но без назначения ролей",
  member: "доступ ко всем участникам",
};

/** Lower-cased label, for a sentence: "роль moderator" -> "роль модератор". */
export function roleLabelInSentence(role: Role): string {
  return ROLE_LABEL[role].toLowerCase();
}
