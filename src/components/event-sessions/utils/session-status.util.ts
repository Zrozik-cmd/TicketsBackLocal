import type {
  EventSessionStatus,
  OrganizerSessionStatus,
} from '../schemas/event-session.schema';
import { ictWallClockToInstant } from '../../events/utils/sales-cutoff.util';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Statuses a session may be switched FROM, per organizer target status:
 * `sold_out` ⇄ `active` is a reversible quota toggle, `cancelled` is terminal.
 * `disabled` is system-owned; the ways out through an organizer action are
 * cancelling it (a show taken off sale may still hold sold tickets — a payment that
 * completed after its slot left the schedule — and its buyers must be told), and
 * reopening (`active`) a flagless (legacy) one whose slot is in the schedule again —
 * `EventSessionsService.bulkSetStatus` enforces that extra condition. Flagless rows only
 * ever came from the schedule sync before `disabledBySchedule` existed and are flagged at
 * boot (`EventSessionsService.healLegacyDisabledSessions`), so that path is a fallback.
 */
export const SESSION_STATUS_SOURCES: Readonly<
  Record<OrganizerSessionStatus, readonly EventSessionStatus[]>
> = {
  active: ['sold_out', 'disabled'],
  sold_out: ['active'],
  cancelled: ['active', 'sold_out', 'disabled'],
};

export type SessionStatusTransition =
  /** Already in the target status — nothing to write, not an error. */
  | 'skip'
  | 'change'
  /** The session is cancelled; nothing brings it back. */
  | 'session_cancelled'
  /** Any other move the organizer may not make (e.g. `disabled` → `sold_out`). */
  | 'invalid_status_transition';

export function resolveSessionStatusTransition(
  from: EventSessionStatus,
  to: OrganizerSessionStatus,
): SessionStatusTransition {
  if (from === to) return 'skip';
  if (from === 'cancelled') return 'session_cancelled';
  return SESSION_STATUS_SOURCES[to].includes(from) ? 'change' : 'invalid_status_transition';
}

/**
 * ICT instant a show ends: `date` at `end`, or the next day at `end` when the show runs
 * past midnight (`end <= start`). `NaN` when the stored times are malformed.
 */
export function sessionEndInstant(session: { date: string; start: string; end: string }): number {
  const start = ictWallClockToInstant(session.date, session.start);
  const end = ictWallClockToInstant(session.date, session.end);
  if (Number.isNaN(start) || Number.isNaN(end)) return Number.NaN;
  return end <= start ? end + DAY_MS : end;
}

/** True once the show is over. Malformed times never count as over. */
export function hasSessionEnded(
  session: { date: string; start: string; end: string },
  now: number = Date.now(),
): boolean {
  const end = sessionEndInstant(session);
  return Number.isFinite(end) && now >= end;
}
