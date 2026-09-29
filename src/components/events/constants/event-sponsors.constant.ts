/**
 * Event sponsors & partners: the "Sponsored by" block of the ticket.
 *
 * The block is **admin content**: it is filled in the admin panel
 * (`PUT /admin/events/:id/sponsors`), never by the organizer, so a save goes straight into
 * `sponsors` — what the ticket renders — with no moderation step in between.
 *
 * `pendingSponsors` is the leftover of the organizer-edited era (option B: the organizer's
 * list waited there while the event kept selling). Nothing writes it any more; an admin
 * resolves a list an organizer left behind by approving it
 * (`POST /admin/events/:id/sponsors/approve`, or the event's own confirm) or simply by saving
 * his own list, which drops it.
 */

/** Sponsors per event. */
export const EVENT_MAX_SPONSORS = 3;

/** Client-generated sponsor id; it keeps a row's logo while the rest of the list is edited. */
export const EVENT_SPONSOR_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Sponsor name printed on the ticket. 15 characters: the name is one 200px line under the logo,
 * and the ticket's font ladder (`services/puppeteer/helpers/sponsor-name-font-size.ts`) shrinks
 * any name of this length until it fits that line — a longer one could only be cut off with an
 * ellipsis there.
 */
export const EVENT_SPONSOR_NAME_MAX_LENGTH = 15;

export const EVENT_SPONSOR_URL_MAX_LENGTH = 500;

/** Decoded size cap of an uploaded logo (the admin form exports a 400x400 PNG). */
export const EVENT_SPONSOR_LOGO_MAX_BYTES = 2 * 1024 * 1024;

export const EVENT_SPONSOR_LOGO_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

export const EVENT_SPONSOR_ERROR = {
  /**
   * 400: the uploaded logo is not a base64 png/jpeg/webp data URL of at most 2 MB, or a
   * `mediaId` is not one of this event's sponsor logos (approved, pending or approved snapshot).
   */
  LOGO_INVALID: 'sponsor_logo_invalid',
  /** 400: a sponsor has a link but the e-mail ticket format is not PDF (a WebP ticket has no clickable links). */
  TICKET_FORMAT_PDF_REQUIRED: 'ticket_format_pdf_required',
  /** 400: two sponsors in one list share an `id`. */
  DUPLICATE_ID: 'sponsor_id_duplicate',
  /** 409 (admin approve): the event has no pending sponsor list. */
  NOT_PENDING: 'sponsors_not_pending',
  /** 409 (admin approve): a MODERATION event is approved as a whole, through confirm. */
  EVENT_IN_MODERATION: 'event_in_moderation',
  /**
   * 409 (admin approve): a DRAFT or REJECTED event is not live as approved; its pending sponsors
   * are approved with the event, through confirm once it is resubmitted.
   */
  EVENT_NOT_APPROVED: 'event_not_approved',
} as const;
