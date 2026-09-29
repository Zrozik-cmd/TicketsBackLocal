import type { IEvent } from '../schemas/event.schema';

/**
 * Organizer/admin-only fields stripped from every public event payload
 * (`EventsService.withoutPrivateFields` — a deny-list: a new private field must be added
 * here or it leaks to the storefront). The ticket-copy mailbox is the organizer's private
 * address; the visibility / archive / soft-delete bookkeeping is never public (a public
 * payload is only built for a visible event anyway); sponsors awaiting approval and the
 * e-mail ticket format are organizer business (the approved `sponsors` stay public).
 */
export const EVENT_PRIVATE_FIELDS = [
  'ticketCopyEmail',
  'hiddenFromSite',
  'hiddenFromSiteAt',
  'hiddenFromSiteBy',
  'archivedByOrganizer',
  'archivedByOrganizerAt',
  'archivedByOrganizerBy',
  'softDeleted',
  'softDeletedAt',
  'softDeletedBy',
  'pendingSponsors',
  'pendingSponsorsAt',
  'ticketFormat',
] as const satisfies readonly (keyof IEvent)[];
