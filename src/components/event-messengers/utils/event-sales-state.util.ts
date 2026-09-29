/**
 * Event-level "can tickets be bought right now?" for the sales closed/opened messages.
 * Pure: the status/visibility/cut-off gate reuses the shared checkout predicates, and
 * seat availability is passed in by the caller (EventSessionsService / EventsService).
 */
import { isEventSalesEnded } from '../../events/utils/sales-cutoff.util';
import { isHiddenFromSite } from '../../events/constants/event-visibility.constant';
import {
  CLOSING_SALES_REASONS,
  OPENING_SALES_REASONS,
  SALES_REASON,
} from '../constants/event-messengers.constants';

export type SalesGateEventLike = Parameters<typeof isEventSalesEnded>[0] & {
  status?: string | null;
  hiddenFromSite?: boolean | null;
  archivedByOrganizer?: boolean | null;
};

export type SalesState =
  | { open: true; reason: string }
  /** `seatsExhausted`: closed only because no seat is left (not the organizer's sold-out mark). */
  | { open: false; reason: string; seatsExhausted?: boolean };

/** Closing reason of a non-ACTIVE status. */
export function statusClosedReason(status: string | null | undefined): string {
  switch (status) {
    case 'MODERATION':
      return SALES_REASON.SENT_BACK_TO_MODERATION;
    case 'COMPLETED':
      return SALES_REASON.EVENT_COMPLETED;
    case 'CANCELLED':
      return SALES_REASON.EVENT_CANCELLED;
    case 'PAUSED':
      return SALES_REASON.SALES_PAUSED;
    case 'REJECTED':
      return SALES_REASON.REJECTED_BY_MODERATION;
    case 'DRAFT':
      return SALES_REASON.MOVED_TO_DRAFT;
    default:
      return `Event status: ${status || 'unknown'}`;
  }
}

/**
 * Everything but seats: `status === 'ACTIVE'`, not hidden and not archived
 * (`isHiddenFromSite`), and a one-off event not past its sales cut-off
 * (`isEventSalesEnded`). `null` when the gate is open and seats decide.
 */
export function evaluateSalesGate(event: SalesGateEventLike, now: number = Date.now()): SalesState | null {
  if (event.status !== 'ACTIVE') return { open: false, reason: statusClosedReason(event.status) };
  if (isHiddenFromSite(event)) {
    return {
      open: false,
      reason: event.archivedByOrganizer === true ? SALES_REASON.ARCHIVED_BY_ORGANIZER : SALES_REASON.HIDDEN_FROM_SITE,
    };
  }
  if (isEventSalesEnded(event, now)) return { open: false, reason: SALES_REASON.SALES_CUTOFF_REACHED };
  return null;
}

/**
 * Seats part. Regular event: the sessions on sale now (`purchasableOnly`) and whether
 * any still has a seat; with none on sale, an upcoming show the organizer marked
 * `sold_out` makes the reason "Sold out" rather than "No upcoming shows". One-off event:
 * the event-wide remaining seat count.
 */
export function evaluateSalesAvailability(
  availability:
    | { recurring: true; purchasableSessions: Array<{ remainingTickets: number }>; soldOutUpcomingSession?: boolean }
    | { recurring: false; remainingSeats: number },
): SalesState {
  if (availability.recurring) {
    if (!availability.purchasableSessions.length) {
      return {
        open: false,
        reason: availability.soldOutUpcomingSession ? SALES_REASON.SOLD_OUT : SALES_REASON.NO_UPCOMING_SHOWS,
      };
    }
    if (!availability.purchasableSessions.some((session) => Number(session.remainingTickets) > 0)) {
      return { open: false, reason: SALES_REASON.SOLD_OUT, seatsExhausted: true };
    }
    return { open: true, reason: SALES_REASON.TICKETS_ON_SALE };
  }
  if (!(Number(availability.remainingSeats) > 0)) {
    return { open: false, reason: SALES_REASON.SOLD_OUT, seatsExhausted: true };
  }
  return { open: true, reason: SALES_REASON.TICKETS_ON_SALE };
}

/**
 * Whether a "sold out" may only be seats held by unpaid online checkouts, which give them back
 * when abandoned: announcing it would print "Sold out", then "Tickets are on sale", for one buyer
 * who changed their mind. The caller then checks for such checkouts and, if any, leaves the
 * stored state alone until they are paid or expire. The organizer's own sold-out mark (explicit
 * `Sold out` reason) is never held back.
 */
export function maySoldOutBeCheckoutHolds(state: SalesState, explicitReason?: string | null): boolean {
  return !state.open && state.seatsExhausted === true && explicitReason?.trim() !== SALES_REASON.SOLD_OUT;
}

/**
 * Reason printed for an edge: the hook's explicit reason unless it points the other way
 * (e.g. "Approved by admin" while the event turned out sold out), then the derived one.
 * Direction-neutral explicit reasons ("Show schedule changed") are always kept.
 */
export function resolveSalesReason(state: SalesState, explicitReason?: string | null): string {
  const explicit = explicitReason?.trim();
  if (!explicit) return state.reason;
  if (state.open && CLOSING_SALES_REASONS.has(explicit)) return state.reason;
  if (!state.open && OPENING_SALES_REASONS.has(explicit)) return state.reason;
  return explicit;
}
