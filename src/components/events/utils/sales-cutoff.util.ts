/**
 * Automatic stop of ticket sales before the start (`event.salesCloseBefore`).
 *
 * The single definition of "is it too late to buy?" shared by the storefront
 * feed, the public event mappers and every order path. Pure — no Nest, no
 * mongoose — so the arithmetic can be exercised on its own.
 *
 * All wall-clock values are ICT (UTC+7) strings, exactly as sessions and
 * `eventDate`/`time` are stored; the instant of `2026-09-12 00:30` is
 * `Date.UTC(2026, 8, 12, 0, 30) - 7h`, never the server's local time.
 */
import { ICT_OFFSET_MS, nowIctClock, todayIct } from './ict-date.util';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Structural shape of `SalesCloseBefore`; tolerant of absent/partial documents. */
export type SalesCloseBeforeRule =
  | { enabled?: boolean | null; value?: number | null; unit?: string | null }
  | null
  | undefined;

/** How long before the start sales stop, in ms; `0` when the rule is off. */
export function salesCutoffMs(rule: SalesCloseBeforeRule): number {
  if (!rule?.enabled) return 0;
  const value = Number(rule.value);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value * (rule.unit === 'hours' ? HOUR_MS : DAY_MS);
}

/** `YYYY-MM-DD` + `HH:mm` in ICT → epoch ms. `NaN` when either part is malformed. */
export function ictWallClockToInstant(date: string | null | undefined, clock: string | null | undefined): number {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec((date ?? '').trim().slice(0, 10));
  const t = /^(\d{1,2}):(\d{2})$/.exec((clock ?? '').trim());
  if (!d || !t) return Number.NaN;
  return (
    Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2])) -
    ICT_OFFSET_MS
  );
}

/**
 * True once `now` has reached `start - cutoff`. With the rule off the cut-off is the
 * start itself, so a show that has already begun is never sold. Malformed stored
 * values never block a sale.
 */
export function isSessionSalesClosed(
  session: { date: string; start: string },
  rule: SalesCloseBeforeRule,
  now: number = Date.now(),
): boolean {
  const start = ictWallClockToInstant(session.date, session.start);
  if (Number.isNaN(start)) return false;
  return now >= start - salesCutoffMs(rule);
}

/**
 * ICT `(date, clock)` of `now + cutoff`, the clock floored to the minute. Session
 * starts are whole minutes, so a session is still on sale exactly when
 * `date > threshold.date || (date === threshold.date && start > threshold.clock)` —
 * the same answer as `!isSessionSalesClosed`, in a form a Mongo filter can express.
 */
export function salesOpenThreshold(
  rule: SalesCloseBeforeRule,
  now: number = Date.now(),
): { date: string; clock: string } {
  const at = now + salesCutoffMs(rule);
  return { date: todayIct(at), clock: nowIctClock(at) };
}

type OneTimeEventLike = {
  recurrence?: { enabled?: boolean | null } | null;
  eventDate?: { startDate?: string | null; isRange?: boolean | null; endDate?: string | null } | null;
  time?: { allDay?: boolean | null; start?: string | null } | null;
  salesCloseBefore?: SalesCloseBeforeRule;
};

/** Start of a one-off event: `eventDate.startDate` at `time.start` (`00:00` when all-day), ICT. */
export function oneTimeEventStartInstant(event: OneTimeEventLike): number {
  return ictWallClockToInstant(
    event.eventDate?.startDate,
    event.time?.allDay ? '00:00' : event.time?.start,
  );
}

/**
 * Start of the LAST day of a one-off event, ICT. A date range (`eventDate.isRange` with
 * `endDate`) runs every day until `endDate`, so that day is taken at the same wall clock
 * as `oneTimeEventStartInstant` — `time.start`, `00:00` when all-day — the convention
 * every sales cut-off here uses. A single-day event, or an unreadable `endDate`, falls
 * back to `oneTimeEventStartInstant` itself.
 */
export function oneTimeEventLastDayStartInstant(event: OneTimeEventLike): number {
  const start = oneTimeEventStartInstant(event);
  if (!event.eventDate?.isRange || !event.eventDate.endDate) return start;
  const lastDay = ictWallClockToInstant(
    event.eventDate.endDate,
    event.time?.allDay ? '00:00' : event.time?.start,
  );
  return Number.isNaN(lastDay) ? start : lastDay;
}

/**
 * Event-level "sales have ended" for one-off events: the rule is on and its cut-off
 * has been reached. Without the rule a one-off event keeps today's behaviour (no
 * time-based check at all). Always `false` for a regular event — there every
 * session carries its own `salesClosed`.
 */
export function isEventSalesEnded(event: OneTimeEventLike, now: number = Date.now()): boolean {
  if (event.recurrence?.enabled === true) return false;
  if (!event.salesCloseBefore?.enabled) return false;
  const start = oneTimeEventStartInstant(event);
  if (Number.isNaN(start)) return false;
  return now >= start - salesCutoffMs(event.salesCloseBefore);
}
