/**
 * Event statuses. Fixed set — also document in .env.example as EVENT_STATUSES.
 * MODERATION = on moderation
 * ACTIVE = default for new/updated events (published)
 * COMPLETED = after event date has passed
 * DRAFT = draft
 * CANCELLED = cancelled
 * PAUSED = paused
 * REJECTED = rejected in moderation (admin)
 */
export const EVENT_STATUSES = [
  'MODERATION',
  'ACTIVE',
  'COMPLETED',
  'DRAFT',
  'CANCELLED',
  'PAUSED',
  'REJECTED',
] as const;

export type EventStatus = (typeof EVENT_STATUSES)[number];

/** Allowed values when creating an event (organizer chooses draft vs moderation). */
export const CREATE_EVENT_INITIAL_STATUSES = ['MODERATION', 'DRAFT'] as const;

export type CreateEventInitialStatus = (typeof CREATE_EVENT_INITIAL_STATUSES)[number];

/**
 * Statuses in which no new order may be created — the single answer to "is this
 * event on sale?" for every checkout path (card, cash, …). Finished/cancelled
 * events keep public archive pages, MODERATION/REJECTED/PAUSED are pulled from
 * sale, so the UI hiding the purchase card is never the only barrier.
 * DRAFT is deliberately not listed: a draft's page opens by direct link as the
 * organizer's preview, and blocking it here would be a behaviour change.
 */
export const SALES_CLOSED_STATUSES: ReadonlySet<EventStatus> = new Set<EventStatus>([
  'COMPLETED',
  'CANCELLED',
  'MODERATION',
  'REJECTED',
  'PAUSED',
]);

export function isSalesClosed(event: { status?: string | null }): boolean {
  return SALES_CLOSED_STATUSES.has((event.status ?? '') as EventStatus);
}
