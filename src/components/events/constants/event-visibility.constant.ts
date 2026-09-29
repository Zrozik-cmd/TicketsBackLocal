/**
 * "Hide from site" — an organizer switch, separate from `status` and from moderation.
 *
 * A hidden event is removed from the whole public storefront (every public list, the
 * hero, favourites, the slug page, the public sessions feed, reviews, the sitemap that
 * reads those lists) and refuses new orders with `event_hidden`. Sold tickets, e-mails,
 * the scanner, cash confirmation of existing bookings, statistics and the organizer and
 * admin panels are unaffected.
 *
 * An event the organizer moved to the archive (`archivedByOrganizer`, set instead of
 * deleting an event that already has sales) is off the site exactly like a hidden one:
 * the same filter and the same `event_hidden` refusal of new orders. So is a soft-deleted
 * event (`softDeleted`, which is always archived as well).
 */

/** API error code of every order-creating path refusing a hidden (or archived) event. */
export const EVENT_HIDDEN_ERROR = 'event_hidden';

/**
 * Mongo condition every public event query adds. `$ne: true` (not `false`) so events
 * saved before the flag existed — no field at all — stay visible.
 */
export const VISIBLE_ON_SITE_FILTER = {
  hiddenFromSite: { $ne: true },
  archivedByOrganizer: { $ne: true },
  softDeleted: { $ne: true },
} as const;

/** Hidden by the organizer, moved to the organizer archive or soft-deleted: off the site either way. */
export function isHiddenFromSite(event: {
  hiddenFromSite?: boolean | null;
  archivedByOrganizer?: boolean | null;
  softDeleted?: boolean | null;
}): boolean {
  return event.hiddenFromSite === true || event.archivedByOrganizer === true || event.softDeleted === true;
}
