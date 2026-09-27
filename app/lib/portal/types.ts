import type { ApprovalStatus, ProfileDTO } from "@/types/auth";
import type { Role } from "@/types/party";

/**
 * Portal data-transfer types.
 *
 * Mirrors the `supabase/migrations/002_portal.sql` columns 1:1 using snake_case,
 * exactly as app/lib/auth/dal.ts does for `join_applications`. Keeping the same
 * convention means the row mapping in the DAL stays trivial and auditable: if a
 * field is spelled differently here, it is a deliberate rename, not an accident.
 *
 * This file is client-safe. Nothing secret may be declared here, and nothing
 * server-only may be imported by it.
 */

/* -------------------------------------------------------------------------- */
/* Account                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The caller's own settings, plus their read-only Steam identity.
 *
 * Extends `ProfileDTO` rather than widening that type: `ProfileDTO` is documented
 * as the minimal projection safe to hand to any component, and the admin panel
 * passes it around freely. Account settings are only ever needed by the tab that
 * renders them, so they live in a separate, larger shape.
 */
export interface AccountProfile extends ProfileDTO {
  displayName: string;
  about: string;
  telegram: string | null;
  contactsPublic: boolean;
  realName: string | null;
  discord: string | null;
  phone: string | null;
  createdAt: string;
  approvedAt: string | null;
}

/** The best name to show for a member: their chosen name, else the Steam one. */
export function displayNameOf(p: {
  displayName: string;
  persona: string;
}): string {
  const trimmed = p.displayName.trim();
  return trimmed.length > 0 ? trimmed : p.persona;
}

/** Fields the member may change on their own profile. */
export interface AccountUpdateInput {
  displayName: string;
  about: string;
  telegram: string;
  contactsPublic: boolean;
}

/* -------------------------------------------------------------------------- */
/* Availability                                                                 */
/* -------------------------------------------------------------------------- */

/** One "I am free from X to Y" slot, minutes from midnight. */
export interface AvailabilitySlot {
  id: string;
  steamId: string;
  /** 0 = Sunday … 6 = Saturday, matching `Date.prototype.getDay()`. */
  weekday: number;
  fromMin: number;
  toMin: number;
}

/** All seven weekdays at once, which is the shape the editor works with. */
export interface AvailabilityWeek {
  weekday: number;
  slots: Array<{ fromMin: number; toMin: number }>;
}

export const WEEKDAY_LABELS = [
  "Воскресенье",
  "Понедельник",
  "Вторник",
  "Среда",
  "Четверг",
  "Пятница",
  "Суббота",
] as const;

export const WEEKDAY_SHORT = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"] as const;

/** 90 minutes, the granularity the editor snaps times to. */
export const AVAILABILITY_STEP_MIN = 30;

/** "540" → "09:00". Minutes are stored as integers to avoid DST drift. */
export function minutesToClock(min: number): string {
  const clamped = Math.max(0, Math.min(1440, Math.round(min)));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** "09:30" → 570. Returns null for anything unparseable. */
export function clockToMinutes(clock: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(clock.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 24 || m > 59) return null;
  const total = h * 60 + m;
  if (total < 0 || total > 1440) return null;
  return total;
}

/**
 * One member's row in the "who is free when" grid that staff use to pick a date.
 * Minutes are already normalised by the caller.
 */
export interface AvailabilityMatrixRow {
  steamId: string;
  name: string;
  role: Role;
  status: ApprovalStatus;
  slots: AvailabilitySlot[];
}

/* -------------------------------------------------------------------------- */
/* Schedule / events                                                           */
/* -------------------------------------------------------------------------- */

export type EventStatus = "draft" | "open" | "finished";
export type AttendanceStatus = "rsvp" | "attended" | "absent";

/**
 * What an event looks like to a human, as opposed to `EventStatus` which is what
 * the database stores.
 *
 * The distinction matters because `status` records whether a staff member closed
 * the event, not whether it happened. An event from last Tuesday that nobody
 * remembered to close is still `open` forever, so a member reading `status` would
 * be told to turn up to an empty hall. Time is the only honest signal, so the
 * state is derived from the clock and the badge is rendered from that.
 */
export type EventState = "draft" | "upcoming" | "live" | "past";

export interface EventRecord {
  id: string;
  title: string;
  description: string;
  location: string;
  startsAt: string;
  endsAt: string | null;
  /** The headcount cap. NULL means unlimited. Mirrors the existing rsvp_limit. */
  rsvpLimit: number | null;
  isPublished: boolean;
  status: EventStatus;
  trackHours: boolean;
  requireRsvp: boolean;
  closedAt: string | null;
  closedBy: string | null;
  /** Derived from `startsAt`/`endsAt` against the current time. See EventState. */
  state: EventState;
  /** Set when a staff member hid the event. It is filtered out of every list. */
  deletedAt: string | null;
}

/**
 * An event as the public website shows it.
 *
 * A deliberately narrower type than `EventRecord`, not a copy of it with the
 * awkward fields left out at the call site. `is_published`, `rsvp_limit`,
 * `require_rsvp` and `closed_by` are internal scheduling state: nothing outside
 * the party needs to know that a draft exists, that a meeting is capped at 40
 * people, or which volunteer closed it out. Keeping the anonymous type separate
 * means a field added for staff use cannot leak onto the public page by accident
 * just because somebody typed `event.…`.
 */
export interface PublicEvent {
  id: string;
  title: string;
  description: string;
  location: string;
  startsAt: string;
  endsAt: string | null;
  /** The display name of whoever scheduled it, or null if unknown/deleted. */
  createdByName: string | null;
  /** Mirrors the per-event `track_hours` switch, so the page can show "с учётом часов". */
  trackHours: boolean;
  /** The stored `status`, so the public page can tell drafts from real events. */
  status: EventStatus;
  /** Time-derived, so the page can say "будет" or "уже прошло". See EventState. */
  publicState: EventState;
}

/** Per-person line inside an event: who came, who didn't, and for how long. */
export interface AttendanceRecord {
  steamId: string;
  name: string;
  status: AttendanceStatus;
  hours: number;
  note: string | null;
}

/**
 * One person who took themselves off an event, and why.
 *
 * Deliberately separate from `AttendanceRecord`. A decline is not attendance with a
 * different label: attendance is closed out by staff once the event is over and
 * drives credited hours, whereas a decline is a statement a member makes while the
 * event is still open, and it carries a reason that staff have to read.
 */
export interface DeclineRecord {
  steamId: string;
  name: string;
  /** Null for non-staff callers; reasons are filtered out in the DAL, not the UI. */
  reason: string | null;
  createdAt: string;
}

/**
 * An event plus the people on it, which is what every schedule view needs: the
 * member-facing list shows who joined, the closing dialog edits the hours.
 */
export interface EventWithAttendance extends EventRecord {
  attendance: AttendanceRecord[];
  /**
   * Everyone who unsubscribed, newest first. Populated for every caller so the
   * names stay consistent with the attendance list, but `reason` is only filled in
   * for staff.
   */
  declines: DeclineRecord[];
  totalHours: number;
  attendedCount: number;
  absentCount: number;
  /** The caller's own line, so the UI can render "you are going" without a join. */
  ownStatus: AttendanceStatus | null;
  /** The caller's own decline, used to render "вы отписались". */
  ownDecline: DeclineRecord | null;
}

export interface EventUpsertInput {
  id?: string;
  title: string;
  description: string;
  location: string;
  startsAt: string;
  endsAt: string | null;
  rsvpLimit: number | null;
  isPublished: boolean;
  status: EventStatus;
  trackHours: boolean;
  requireRsvp: boolean;
}

/**
 * Joining needs nothing but the event; leaving demands a reason, because "I
 * cancelled" on its own tells staff nothing they can act on. The requirement is
 * enforced in the DAL — the dialog is a courtesy, not the boundary.
 */
export interface RsvpInput {
  eventId: string;
  attending: boolean;
  reason?: string;
}

/** One row of the closing dialog: did they come, and for how long. */
export interface AttendanceInput {
  steamId: string;
  status: AttendanceStatus;
  hours: number;
  note: string;
}

/* -------------------------------------------------------------------------- */
/* Appeals                                                                      */
/* -------------------------------------------------------------------------- */

export type AppealStatus = "new" | "in_review" | "done" | "rejected";

export interface AppealRecord {
  id: string;
  author: string;
  authorName: string;
  title: string;
  body: string;
  status: AppealStatus;
  staffReply: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export const APPEAL_STATUS_LABELS: Record<AppealStatus, string> = {
  new: "Новое",
  in_review: "На рассмотрении",
  done: "Готово",
  rejected: "Отклонено",
};

/* -------------------------------------------------------------------------- */
/* Polls                                                                        */
/* -------------------------------------------------------------------------- */

export type PollStatus = "open" | "closed";

export interface PollOption {
  id: string;
  label: string;
  position: number;
  /** Number of votes, from poll_votes. Null when the caller may not see results. */
  votes: number | null;
  /** True when the caller has already picked this option. */
  ownVote: boolean;
}

export interface PollRecord {
  id: string;
  author: string;
  authorName: string;
  question: string;
  description: string;
  multiple: boolean;
  status: PollStatus;
  closesAt: string | null;
  createdAt: string;
  options: PollOption[];
  totalVotes: number;
  /** How many distinct people voted, which is the number that matters. */
  voterCount: number;
}

export const POLL_STATUS_LABELS: Record<PollStatus, string> = {
  open: "Открыт",
  closed: "Закрыт",
};

/* -------------------------------------------------------------------------- */
/* Map                                                                          */
/* -------------------------------------------------------------------------- */

export type WorkPointKind = "work" | "event" | "other";
export type WorkPointStatus = "draft" | "published" | "hidden";

export interface WorkPointRecord {
  id: string;
  title: string;
  description: string;
  imgurUrl: string;
  kind: WorkPointKind;
  /** Percentages of the map image box, 0–100. Not pixels — see the migration. */
  xPct: number;
  yPct: number;
  status: WorkPointStatus;
  createdBy: string;
  createdByName: string;
  createdAt: string;
}

export const WORK_POINT_KIND_LABELS: Record<WorkPointKind, string> = {
  work: "Работа",
  event: "Мероприятие",
  other: "Прочее",
};

export const WORK_POINT_STATUS_LABELS: Record<WorkPointStatus, string> = {
  draft: "Черновик",
  published: "Опубликована",
  hidden: "Скрыта",
};

export interface WorkPointInput {
  id?: string;
  title: string;
  description: string;
  imgurUrl: string;
  kind: WorkPointKind;
  xPct: number;
  yPct: number;
  status: WorkPointStatus;
}

/* -------------------------------------------------------------------------- */
/* Registry and reports                                                        */
/* -------------------------------------------------------------------------- */

/** A row of the member registry, as shown to staff. */
/**
 * One manual correction to a member's worked hours.
 *
 * Kept separate from the event roster it adjusts: an event produces one
 * `event_attendance` row per person, but a leader crediting a shift nobody logged
 * is not an event, and writing it as one would put a meeting on the public
 * schedule that never happened.
 */
export interface HoursAdjustmentRecord {
  id: number;
  steamId: string;
  /** Signed. Negative takes hours back. */
  hours: number;
  reason: string;
  /** Display name of the staff member who wrote it, null if their profile is gone. */
  author: string | null;
  createdAt: string;
}

export interface RegistryEntry {
  steamId: string;
  displayName: string;
  persona: string;
  role: Role;
  status: ApprovalStatus;
  about: string;
  telegram: string | null;
  discord: string | null;
  phone: string | null;
  contactsPublic: boolean;
  createdAt: string;
  approvedAt: string | null;
  totalHours: number;
  eventsAttended: number;
  eventsAbsent: number;
}

/** The caller's own numbers, for the dashboard. */
export interface MyHours {
  totalHours: number;
  eventsAttended: number;
  eventsAbsent: number;
  upcomingCount: number;
}

export interface AuditEntry {
  id: string;
  actor: string | null;
  actorName: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  meta: Record<string, unknown>;
  createdAt: string;
}
