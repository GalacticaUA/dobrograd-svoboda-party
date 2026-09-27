/**
 * Russian date and time formatting.
 *
 * The formatters are module-level constants rather than per-call options objects.
 * Constructing an `Intl.DateTimeFormat` is the expensive part — it compiles a
 * locale pattern and loads locale data — and building one inside a `.map()` over
 * a list of events means paying that cost once per row, on every render of the
 * homepage. A `DateTimeFormat` is stateless and safe to share.
 *
 * `timeZone: "Europe/Moscow"` is explicit on every formatter. The server renders
 * these strings and the browser hydrates the markup, so without it the two could
 * disagree: a build step or a request served by a host in another zone would
 * render a different hour than the visitor's browser expects, and React would
 * report a text-content mismatch. Pinning the zone makes the markup deterministic
 * regardless of where it is rendered. Moscow is chosen because the party is
 * based there, not because of the server's locale.
 */

const ZONE = "Europe/Moscow";

const dayMonth = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "long",
  timeZone: ZONE,
});

const dayMonthShort = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "short",
  timeZone: ZONE,
});

const weekdayLong = new Intl.DateTimeFormat("ru-RU", {
  weekday: "long",
  timeZone: ZONE,
});

const time = new Intl.DateTimeFormat("ru-RU", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: ZONE,
});

/** `12 октября` */
export function formatEventDay(iso: string): string {
  return dayMonth.format(new Date(iso));
}

/** `12 окт.` */
export function formatEventDayShort(iso: string): string {
  return dayMonthShort.format(new Date(iso));
}

/** `воскресенье` */
export function formatEventWeekday(iso: string): string {
  return weekdayLong.format(new Date(iso));
}

/** `18:30` */
export function formatEventTime(iso: string): string {
  return time.format(new Date(iso));
}

/**
 * `18:30 – 22:00`, or just `18:30` when the event has no end time.
 *
 * The range is only meaningful when both ends fall on the same day, which is
 * almost always true. An overnight event would otherwise read "23:00 – 02:00",
 * so the end date is included in that one case.
 */
export function formatEventTimeRange(startsAt: string, endsAt: string | null): string {
  const start = formatEventTime(startsAt);
  if (!endsAt) return start;

  const from = new Date(startsAt);
  const to = new Date(endsAt);

  // Both ends must fall on the same Moscow calendar date, otherwise the range
  // would read as "23:00 – 02:00" for what is really a one-night event.
  const sameCalendarDay = dayMonthShort.format(from) === dayMonthShort.format(to);

  return sameCalendarDay
    ? `${start} – ${formatEventTime(endsAt)}`
    : `${start} – ${formatEventDayShort(endsAt)}, ${formatEventTime(endsAt)}`;
}
