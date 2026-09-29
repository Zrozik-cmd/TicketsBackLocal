/**
 * Per-event messenger notifications (LINE groups today; more providers later).
 *
 * An admin connects a messenger bot to ONE event; the bot is added to that event's
 * group chat and the backend pushes short English messages there on sales, session
 * cancellations, sales closing/opening and new reviews.
 */

export const EVENT_MESSENGER_PROVIDERS = ['line'] as const;
export type EventMessengerProvider = (typeof EVENT_MESSENGER_PROVIDERS)[number];

export const EVENT_MESSENGER_DELIVERY_KINDS = [
  'order_paid',
  'session_cancelled',
  'sales_closed',
  'sales_opened',
  'review_created',
  'test',
] as const;
export type EventMessengerDeliveryKind = (typeof EVENT_MESSENGER_DELIVERY_KINDS)[number];

export const EVENT_MESSENGER_DELIVERY_STATUSES = ['pending', 'sent', 'failed'] as const;
export type EventMessengerDeliveryStatus = (typeof EVENT_MESSENGER_DELIVERY_STATUSES)[number];

/** How the group id got onto the integration: the bot's `join` webhook or typed in by an admin. */
export const LINE_GROUP_SOURCES = ['webhook', 'manual'] as const;
export type LineGroupSource = (typeof LINE_GROUP_SOURCES)[number];

/** Groups an admin disconnected that are remembered (never re-captured from a plain group message). */
export const LINE_DETACHED_GROUP_IDS_MAX = 20;

export const EVENT_MESSENGER_TRIGGER_KEYS = [
  'orderPaid',
  'sessionCancelled',
  'salesClosed',
  'salesOpened',
  'reviewCreated',
] as const;
export type EventMessengerTriggerKey = (typeof EVENT_MESSENGER_TRIGGER_KEYS)[number];
export type EventMessengerTriggers = Record<EventMessengerTriggerKey, boolean>;

/** A new integration reports everything but reviews (customer decision 2026-09-18). */
export const DEFAULT_EVENT_MESSENGER_TRIGGERS: Readonly<EventMessengerTriggers> = {
  orderPaid: true,
  sessionCancelled: true,
  salesClosed: true,
  salesOpened: true,
  reviewCreated: false,
};

/** Whether a trigger switch is on; a key missing on a stored integration takes its default. */
export function isMessengerTriggerOn(
  triggers: Partial<EventMessengerTriggers> | null | undefined,
  key: EventMessengerTriggerKey,
): boolean {
  const value = triggers?.[key];
  return typeof value === 'boolean' ? value : DEFAULT_EVENT_MESSENGER_TRIGGERS[key];
}

/** Which trigger switch governs a delivery kind (`test` is never gated). */
export const DELIVERY_KIND_TRIGGER: Readonly<Record<EventMessengerDeliveryKind, EventMessengerTriggerKey | null>> = {
  order_paid: 'orderPaid',
  session_cancelled: 'sessionCancelled',
  sales_closed: 'salesClosed',
  sales_opened: 'salesOpened',
  review_created: 'reviewCreated',
  test: null,
};

/** Delay before retry N (after failed attempt N), in minutes. */
export const DELIVERY_RETRY_BACKOFF_MINUTES = [1, 5, 15, 60] as const;
/** Attempts in total, the first one included. */
export const DELIVERY_MAX_ATTEMPTS = 5;
/** A `pending` delivery older than this is not in flight any more (a push times out after 10 s). */
export const DELIVERY_STALE_PENDING_MS = 5 * 60 * 1000;
/** Deliveries retried per cron run, so one run can never stall on a backlog. */
export const DELIVERY_RETRY_BATCH = 100;

export const DELIVERIES_DEFAULT_LIMIT = 20;
export const DELIVERIES_MAX_LIMIT = 100;
export const DELIVERY_TEXT_PREVIEW_LENGTH = 200;

/** Failed deliveries one manual "resend failed" run may take (the admin picks one, or "all"). */
export const DELIVERY_RETRY_LIMIT_OPTIONS = [10, 20, 50] as const;
export type DeliveryRetryLimit = (typeof DELIVERY_RETRY_LIMIT_OPTIONS)[number];
/** Hard ceiling of one manual run, "all" included: a huge backlog is resent in several clicks. */
export const DELIVERY_MANUAL_RETRY_MAX = 200;
/**
 * Wall clock one manual run may spend pushing. The run is one synchronous request: a longer one
 * dies in a proxy timeout and the admin page waits for an answer that never comes. Rows the run
 * did not reach are untouched (`failed`), so the next click takes them.
 *
 * The deadline is checked before each push, so the true ceiling is this budget plus the push that
 * was already running — at worst one `LINE_API_TIMEOUT_MS` more.
 */
export const DELIVERY_MANUAL_RETRY_BUDGET_MS = 15_000;

/** LINE text message limit (characters). */
export const LINE_TEXT_MAX_LENGTH = 5000;
/** Review text quoted in the group message. */
export const REVIEW_MESSAGE_MAX_LENGTH = 1500;

export const LINE_API_TIMEOUT_MS = 10_000;
export const DEFAULT_LINE_API_BASE_URL = 'https://api.line.me';
/** Must match the raw-body middleware path registered in `main.ts`. */
export const LINE_WEBHOOK_PATH = 'integrations/line/webhook';

/** A LINE group id as the Messaging API reports it: `C` + 32 lowercase hex digits. */
export const LINE_GROUP_ID_PATTERN = /^C[0-9a-f]{32}$/;
export const LINE_CHANNEL_ACCESS_TOKEN_MAX_LENGTH = 500;
export const LINE_CHANNEL_SECRET_MAX_LENGTH = 100;

export const EVENT_MESSENGER_ERROR = {
  EVENT_NOT_FOUND: 'event_not_found',
  LINE_CREDENTIALS_REQUIRED: 'line_credentials_required',
  LINE_TOKEN_INVALID: 'line_token_invalid',
  LINE_API_UNREACHABLE: 'line_api_unreachable',
  LINE_INTEGRATION_NOT_FOUND: 'line_integration_not_found',
  LINE_INTEGRATION_CONFLICT: 'line_integration_conflict',
  LINE_GROUP_NOT_CONNECTED: 'line_group_not_connected',
  LINE_PUSH_FAILED: 'line_push_failed',
  LINE_TEST_CONFLICT: 'line_test_conflict',
  LINE_WEBHOOK_NOT_FOUND: 'line_webhook_not_found',
  LINE_SIGNATURE_INVALID: 'line_signature_invalid',
} as const;

/**
 * Reasons printed in "Sales closed / opened". Explicit hooks pass one of these; the
 * sweep (and any hook whose reason contradicts the detected edge) derives one from the
 * failing condition instead.
 */
export const SALES_REASON = {
  SENT_BACK_TO_MODERATION: 'Sent back to moderation',
  APPROVED_BY_ADMIN: 'Approved by admin',
  HIDDEN_FROM_SITE: 'Hidden from the site',
  SHOWN_ON_SITE: 'Shown on the site',
  ARCHIVED_BY_ORGANIZER: 'Archived by the organizer',
  RESTORED_BY_ORGANIZER: 'Restored by the organizer',
  EVENT_COMPLETED: 'Event completed',
  SOLD_OUT: 'Sold out',
  TICKETS_AVAILABLE_AGAIN: 'Tickets available again',
  SHOW_SCHEDULE_CHANGED: 'Show schedule changed',
  SALES_CUTOFF_REACHED: 'Sales cut-off reached',
  NO_UPCOMING_SHOWS: 'No upcoming shows',
  EVENT_CANCELLED: 'Event cancelled',
  SALES_PAUSED: 'Sales paused',
  REJECTED_BY_MODERATION: 'Rejected by moderation',
  MOVED_TO_DRAFT: 'Moved to draft',
  TICKETS_ON_SALE: 'Tickets are on sale',
} as const;

/** Reasons that only make sense for a closing edge. */
export const CLOSING_SALES_REASONS: ReadonlySet<string> = new Set<string>([
  SALES_REASON.SENT_BACK_TO_MODERATION,
  SALES_REASON.HIDDEN_FROM_SITE,
  SALES_REASON.ARCHIVED_BY_ORGANIZER,
  SALES_REASON.EVENT_COMPLETED,
  SALES_REASON.SOLD_OUT,
  SALES_REASON.SALES_CUTOFF_REACHED,
  SALES_REASON.NO_UPCOMING_SHOWS,
  SALES_REASON.EVENT_CANCELLED,
  SALES_REASON.SALES_PAUSED,
  SALES_REASON.REJECTED_BY_MODERATION,
  SALES_REASON.MOVED_TO_DRAFT,
]);

/** Reasons that only make sense for an opening edge. */
export const OPENING_SALES_REASONS: ReadonlySet<string> = new Set<string>([
  SALES_REASON.APPROVED_BY_ADMIN,
  SALES_REASON.SHOWN_ON_SITE,
  SALES_REASON.RESTORED_BY_ORGANIZER,
  SALES_REASON.TICKETS_AVAILABLE_AGAIN,
  SALES_REASON.TICKETS_ON_SALE,
]);
