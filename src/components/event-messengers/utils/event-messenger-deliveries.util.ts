import {
  DELIVERIES_DEFAULT_LIMIT,
  DELIVERIES_MAX_LIMIT,
  DELIVERY_MANUAL_RETRY_MAX,
  DELIVERY_TEXT_PREVIEW_LENGTH,
  isMessengerTriggerOn,
  type EventMessengerDeliveryKind,
  type EventMessengerDeliveryStatus,
  type EventMessengerTriggerKey,
  type EventMessengerTriggers,
} from '../constants/event-messengers.constants';

/*
 * Pure helpers of the admin delivery log (`GET .../line/deliveries`, `POST .../deliveries/retry`).
 * No Nest, no mongoose: every rule here is a function of its arguments.
 */

/** One row of the admin delivery log. */
export type EventMessengerDeliveryView = {
  id: number;
  kind: EventMessengerDeliveryKind;
  status: EventMessengerDeliveryStatus;
  attempts: number;
  lastError: string | null;
  sentAt: string | null;
  createdAt: string | null;
  /** First `DELIVERY_TEXT_PREVIEW_LENGTH` characters — what the table cell shows. */
  textPreview: string;
  /** The whole message — what the "full text" modal shows. */
  text: string;
};

/** The delivery fields a view is built from (a lean document satisfies it). */
export type DeliveryRowLike = {
  id: number;
  kind: EventMessengerDeliveryKind;
  status: EventMessengerDeliveryStatus;
  attempts?: number | null;
  lastError?: string | null;
  sentAt?: Date | string | null;
  createdAt?: Date | string | null;
  text?: string | null;
};

/** One page of the log, plus the counters the admin table shows above it. */
export type EventMessengerDeliveryPage = {
  items: EventMessengerDeliveryView[];
  total: number;
  limit: number;
  offset: number;
  failedCount: number;
};

/** The integration fields the "may this be pushed?" rule reads (a lean integration satisfies it). */
export type MessengerSendTarget = {
  enabled?: boolean | null;
  line?: { groupId?: string | null } | null;
  triggers?: Partial<EventMessengerTriggers> | null;
};

/**
 * Why nothing may be pushed to this integration right now, or `null`. THE rule behind every
 * send: the first attempt (`EventMessengersNotifierService.canSend`), the retry cron and the
 * admin's manual "resend failed" all ask it, so a removed integration, a disconnected group or
 * a switched-off trigger stops all three alike. `trigger: null` asks about the integration only
 * (a `test` message is gated by no switch).
 */
export function messengerSendBlockedReason(
  integration: MessengerSendTarget | null | undefined,
  trigger: EventMessengerTriggerKey | null,
): string | null {
  if (!integration) return 'integration removed';
  if (integration.enabled === false) return 'integration disabled';
  if (!integration.line?.groupId) return 'no LINE group connected';
  if (trigger && !isMessengerTriggerOn(integration.triggers, trigger)) return 'trigger switched off';
  return null;
}

/** ISO string of a date-ish value; `null` for missing or unparsable ones. */
export function isoOrNull(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * `limit` / `offset` of the log as the query string carries them: `limit` defaults to
 * `DELIVERIES_DEFAULT_LIMIT` and is clamped to 1…`DELIVERIES_MAX_LIMIT`, `offset` defaults
 * to 0 and is never negative. Anything unparsable falls back to the default.
 */
export function parseDeliveriesPaging(
  limitRaw?: string | number | null,
  offsetRaw?: string | number | null,
): { limit: number; offset: number } {
  const parsedLimit = Number.parseInt(String(limitRaw ?? ''), 10);
  const limit = Number.isFinite(parsedLimit)
    ? Math.min(Math.max(parsedLimit, 1), DELIVERIES_MAX_LIMIT)
    : DELIVERIES_DEFAULT_LIMIT;
  const parsedOffset = Number.parseInt(String(offsetRaw ?? ''), 10);
  const offset = Number.isFinite(parsedOffset) ? Math.max(parsedOffset, 0) : 0;
  return { limit, offset };
}

/** How many failed deliveries one manual run takes: the admin's choice, or all, both capped. */
export function manualRetryBatchSize(limit?: number | null): number {
  const wanted = typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : null;
  return wanted === null ? DELIVERY_MANUAL_RETRY_MAX : Math.min(wanted, DELIVERY_MANUAL_RETRY_MAX);
}

export function toDeliveryView(row: DeliveryRowLike): EventMessengerDeliveryView {
  const text = row.text ?? '';
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    attempts: row.attempts ?? 0,
    lastError: row.lastError ?? null,
    sentAt: isoOrNull(row.sentAt),
    createdAt: isoOrNull(row.createdAt),
    textPreview: text.slice(0, DELIVERY_TEXT_PREVIEW_LENGTH),
    text,
  };
}
