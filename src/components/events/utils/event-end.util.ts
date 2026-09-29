/**
 * When an event is over — the instant its last show ends, ICT. Pure (no Nest, no mongoose).
 *
 * Wall-clock values are ICT strings as stored (`eventDate`, `time`, `recurrence`), turned
 * into instants by `ictWallClockToInstant`, never the server's local time.
 *
 * - One-off: the last day (`eventDate.endDate` of a range, else `startDate`) at `time.end`;
 *   an end not after the start is a show past midnight, so it ends the next day. All-day,
 *   or no readable end time: the end of that last day (24:00).
 * - Regular: the end of `recurrence.periodEnd` (24:00), or later when a show that starts
 *   that day runs past midnight. Skipped dates and cancelled sessions are not considered —
 *   at worst the event counts as running until the end of its period.
 *
 * Unreadable dates give `NaN`: such an event is never "over" by time.
 */
import { ictWallClockToInstant } from './sales-cutoff.util';

const DAY_MS = 24 * 60 * 60 * 1000;

type Clock = string | null | undefined;

export type EventEndLike = {
  recurrence?: {
    enabled?: boolean | null;
    periodEnd?: string | null;
    sessions?: Array<{ start?: Clock; end?: Clock }> | null;
  } | null;
  eventDate?: { startDate?: string | null; isRange?: boolean | null; endDate?: string | null } | null;
  time?: { allDay?: boolean | null; start?: Clock; end?: Clock } | null;
};

/** End of a show held on `day` from `start` to `end`; `NaN` when the end time is unreadable. */
function showEnd(day: string | null | undefined, start: Clock, end: Clock): number {
  const startAt = ictWallClockToInstant(day, start);
  const endAt = ictWallClockToInstant(day, end);
  if (Number.isNaN(endAt)) return Number.NaN;
  return Number.isFinite(startAt) && endAt <= startAt ? endAt + DAY_MS : endAt;
}

export function eventEndInstant(event: EventEndLike): number {
  if (event.recurrence?.enabled === true) {
    const lastDay = event.recurrence.periodEnd;
    const dayEnd = ictWallClockToInstant(lastDay, '00:00') + DAY_MS;
    if (Number.isNaN(dayEnd)) return Number.NaN;
    let end = dayEnd;
    for (const session of event.recurrence.sessions ?? []) {
      const sessionEnd = showEnd(lastDay, session?.start, session?.end);
      if (Number.isFinite(sessionEnd) && sessionEnd > end) end = sessionEnd;
    }
    return end;
  }

  const date = event.eventDate;
  const rangeEnd = date?.isRange && date.endDate ? date.endDate : null;
  // An unreadable range end falls back to the start day (as in the sales cut-off helpers).
  const lastDay = rangeEnd && !Number.isNaN(ictWallClockToInstant(rangeEnd, '00:00')) ? rangeEnd : date?.startDate;
  const dayStart = ictWallClockToInstant(lastDay, '00:00');
  if (Number.isNaN(dayStart)) return Number.NaN;
  if (event.time?.allDay) return dayStart + DAY_MS;
  const end = showEnd(lastDay, event.time?.start, event.time?.end);
  return Number.isNaN(end) ? dayStart + DAY_MS : end;
}

/** The event's last show has ended (see `eventEndInstant`). */
export function isEventOver(event: EventEndLike, now: number = Date.now()): boolean {
  const end = eventEndInstant(event);
  return Number.isFinite(end) && now >= end;
}
