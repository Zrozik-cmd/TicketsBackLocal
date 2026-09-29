/**
 * Organizer "delete event" (`POST /events/:id/remove`, `DELETE /events/:id`).
 *
 * An event without sales is deleted (snapshot in `deletedevents`, like an admin delete).
 * An event that already has sales — tickets, orders that carry money or can still become
 * tickets, payouts to the organizer (financial records, an advance too), or a link from an
 * active site banner — is moved to the organizer archive instead (`archivedByOrganizer`):
 * off the site like a hidden event, frozen for edits, restorable by the organizer at any
 * time. Sold tickets stay valid.
 */

/** 409: an archived event cannot be edited, hidden or switched until restored. */
export const EVENT_ARCHIVED_ERROR = 'event_archived';
/** 409: the dialog confirmed a delete but the event has sales now (or the reverse). */
export const EVENT_REMOVAL_OUTCOME_CHANGED_ERROR = 'event_removal_outcome_changed';
/** 409: a sale landed while deleting, so the event was put back. */
export const EVENT_DELETE_ROLLED_BACK_ERROR = 'event_delete_rolled_back';
/** 500: the post-delete re-check could not run, so the event was put back. */
export const EVENT_DELETE_RECHECK_FAILED_ERROR = 'event_delete_recheck_failed';
/** 500: the `deletedevents` snapshot could not be written, nothing was deleted. */
export const EVENT_DELETE_ARCHIVE_FAILED_ERROR = 'event_delete_archive_failed';
/** 500: the event is deleted and could not be put back (restore from `deletedevents`). */
export const EVENT_DELETE_ROLLBACK_FAILED_ERROR = 'event_delete_rollback_failed';

/** Orders that carry money or can still become tickets: any of them makes a removal an archive. */
export const EVENT_SALE_ORDER_STATUSES = ['wait', 'pending_cash', 'paid', 'refunded'] as const;

/** Why a removal archives the event instead of deleting it (check order = display order). */
export type EventRemovalArchiveReason =
  | 'has_tickets'
  | 'has_paid_orders'
  | 'has_pending_cash_orders'
  | 'has_wait_orders'
  | 'has_refunded_orders'
  | 'has_payouts'
  | 'linked_from_active_banner';

/** Non-blocking hints for the confirmation dialog. */
export type EventRemovalWarning =
  | 'event_is_public'
  | 'valid_tickets_remain'
  | 'upcoming_shows_with_sales';

export type EventRemovalCounts = {
  /** Issued ticket documents, any status. */
  tickets: number;
  /** Tickets not scanned yet (`ACTIVE`). */
  activeTickets: number;
  paidOrders: number;
  pendingCashOrders: number;
  waitOrders: number;
  refundedOrders: number;
  /** Recurring events: not cancelled, not started yet (ICT) shows with sold tickets. */
  upcomingShowsWithSales: number;
  /** Payouts to the organizer for the event, any status (finance `organizer_payouts`). */
  payouts: number;
  /** Active banners whose href leads to the event. Never exposed to the organizer. */
  activeBanners: number;
  /**
   * ARBI Pay stores of the event (active/pending). Not an archive reason: with a store the
   * delete is a soft delete (`events/event-soft-delete.ts`). Never exposed to the organizer.
   */
  arbipayStores: number;
};

export function eventRemovalArchiveReasons(c: EventRemovalCounts): EventRemovalArchiveReason[] {
  const reasons: EventRemovalArchiveReason[] = [];
  if (c.tickets > 0) reasons.push('has_tickets');
  if (c.paidOrders > 0) reasons.push('has_paid_orders');
  if (c.pendingCashOrders > 0) reasons.push('has_pending_cash_orders');
  if (c.waitOrders > 0) reasons.push('has_wait_orders');
  if (c.refundedOrders > 0) reasons.push('has_refunded_orders');
  if (c.payouts > 0) reasons.push('has_payouts');
  if (c.activeBanners > 0) reasons.push('linked_from_active_banner');
  return reasons;
}
