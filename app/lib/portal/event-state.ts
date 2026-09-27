/**
 * What an event looks like to a human, derived from the clock.
 *
 * Client-safe by design — no `server-only`, no secrets, no imports. The same
 * `eventState()` runs in the DAL, where it decides what the schedule renders, and
 * in the closing dialog, where it sets the ceiling on the hours slider. The two
 * must not be able to disagree: a badge reading "Будет" next to a slider that
 * refuses to go past the event's length is the kind of contradiction nobody
 * notices until it is in front of a member.
 *
 * The point of deriving from time rather than from `status` is that they answer
 * different questions. `status` records whether a staff member pressed "завершить";
 * a meeting from last Tuesday that nobody remembered to close stays `open` forever,
 * and a member reading `status` would be told to turn up to an empty hall. The date
 * is the only signal that cannot rot.
 */

import type { EventState, EventStatus } from "@/lib/portal/types";

/**
 * Length limits for the event form, shared by the input's `maxLength` and the
 * DAL's truncation.
 *
 * They live here rather than in each caller because the two are the same rule
 * seen from two sides. When they were separate numbers the form allowed 2000
 * characters, the DAL wrote 2000, and the check constraint in the database
 * silently disagreed with both — a mismatch that only surfaces as a 500 from
 * PostgREST at save time. One constant, three call sites.
 *
 * 50 and 250 are what the event card can render: one line of title and a short
 * lead. Anything longer was being truncated by CSS, which looks identical to a
 * bug and is invisible to the person who typed it.
 */
export const EVENT_TITLE_MAX = 50;
export const EVENT_DESCRIPTION_MAX = 250;

export function eventState(
  status: EventStatus,
  startsAt: string,
  endsAt: string | null,
  now: number = Date.now(),
): EventState {
  if (status === "draft") return "draft";

  const starts = new Date(startsAt).getTime();
  if (Number.isNaN(starts)) return "upcoming";
  if (now < starts) return "upcoming";

  // No end time means there is no window during which the event could be running,
  // so once it has started there is nothing left to attend.
  if (!endsAt) return "past";

  const ends = new Date(endsAt).getTime();
  if (Number.isNaN(ends)) return "past";

  return now < ends ? "live" : "past";
}

/**
 * How long the event is planned to run, in hours. 0 when it has no end time, or
 * when the times are unusable.
 *
 * Used as the ceiling for the hours slider, because it is the only number that can
 * catch a typo: entering 14 for a meeting that ran from 18:00 to 20:00 is always
 * wrong, and a bounded control makes that visible rather than merely unlikely.
 */
export function eventDurationHours(startsAt: string, endsAt: string | null): number {
  if (!endsAt) return 0;

  const starts = new Date(startsAt).getTime();
  const ends = new Date(endsAt).getTime();
  if (Number.isNaN(starts) || Number.isNaN(ends) || ends <= starts) return 0;

  return (ends - starts) / 3_600_000;
}
