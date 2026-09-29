/**
 * LINE webhook helpers. Pure (no Nest, no mongoose).
 *
 * LINE signs the exact request bytes: `x-line-signature` is base64 HMAC-SHA256 of the
 * raw body keyed with the channel secret. The body must therefore be read raw (see the
 * `express.raw` registration in `main.ts`), never re-serialised JSON.
 */
import { createHmac, timingSafeEqual } from 'crypto';
import { LINE_DETACHED_GROUP_IDS_MAX, LINE_WEBHOOK_PATH } from '../constants/event-messengers.constants';

export function computeLineSignature(channelSecret: string, rawBody: Buffer | string): string {
  return createHmac('sha256', channelSecret).update(rawBody).digest('base64');
}

/** Constant-time comparison of the header with the expected signature. */
export function verifyLineSignature(
  channelSecret: string | null | undefined,
  rawBody: Buffer | null | undefined,
  signature: string | string[] | null | undefined,
): boolean {
  if (!channelSecret || !Buffer.isBuffer(rawBody) || typeof signature !== 'string') return false;
  const given = Buffer.from(signature.trim(), 'utf8');
  if (!given.length) return false;
  const expected = Buffer.from(computeLineSignature(channelSecret, rawBody), 'utf8');
  if (expected.length !== given.length) return false;
  return timingSafeEqual(expected, given);
}

export type ParsedLineWebhookEvent = {
  type: string;
  sourceType: string | null;
  groupId: string | null;
};

export type ParsedLineWebhook = {
  destination: string | null;
  events: ParsedLineWebhookEvent[];
};

const MAX_ID_LENGTH = 100;

function readId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= MAX_ID_LENGTH ? trimmed : null;
}

/**
 * Parses a verified webhook body. `null` for a body that is not a JSON object; events
 * that are not objects or have no `type` are dropped. Never throws.
 */
export function parseLineWebhookBody(rawBody: Buffer | string): ParsedLineWebhook | null {
  let body: unknown;
  try {
    body = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody);
  } catch {
    return null;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const record = body as { destination?: unknown; events?: unknown };
  const events: ParsedLineWebhookEvent[] = [];
  if (Array.isArray(record.events)) {
    for (const item of record.events) {
      if (!item || typeof item !== 'object') continue;
      const event = item as { type?: unknown; source?: unknown };
      if (typeof event.type !== 'string' || !event.type) continue;
      const source = event.source && typeof event.source === 'object'
        ? (event.source as { type?: unknown; groupId?: unknown })
        : null;
      events.push({
        type: event.type,
        sourceType: typeof source?.type === 'string' ? source.type : null,
        groupId: readId(source?.groupId),
      });
    }
  }
  return { destination: readId(record.destination), events };
}

export type LineGroupAction =
  /** The bot was added to a group while none (or this same one) is connected: that group becomes the integration's group. */
  | { kind: 'join'; groupId: string }
  /**
   * The bot was added to some other group while a group is connected. Not applied: anyone
   * who befriends the bot can invite it anywhere, and buyer data must not follow it.
   */
  | { kind: 'ignored_join'; groupId: string }
  /** The bot left (was removed from) the connected group. */
  | { kind: 'leave'; groupId: string }
  /** Any other group-sourced event while no group is connected: adopt that group (unless an admin detached it). */
  | { kind: 'capture'; groupId: string };

/**
 * What a batch of webhook events does to the connected group, applied in order starting
 * from `currentGroupId`. Only group-sourced events count; `leave` of some other group
 * and events from users/rooms are ignored. A `join` only connects while no group is
 * connected (or re-joins the connected one). Groups in `detachedGroupIds` (disconnected
 * by an admin) are never captured from a plain event; a `join` from one reconnects it.
 */
export function planLineGroupActions(
  events: ParsedLineWebhookEvent[],
  currentGroupId: string | null,
  detachedGroupIds: readonly string[] | null = null,
): LineGroupAction[] {
  const actions: LineGroupAction[] = [];
  let current = currentGroupId;
  const detached = new Set(detachedGroupIds ?? []);
  for (const event of events) {
    if (event.sourceType !== 'group' || !event.groupId) continue;
    if (event.type === 'join') {
      if (current === null || current === event.groupId) {
        actions.push({ kind: 'join', groupId: event.groupId });
        current = event.groupId;
        detached.delete(event.groupId);
      } else {
        actions.push({ kind: 'ignored_join', groupId: event.groupId });
      }
    } else if (event.type === 'leave') {
      if (current === event.groupId) {
        actions.push({ kind: 'leave', groupId: event.groupId });
        current = null;
      }
    } else if (current === null && !detached.has(event.groupId)) {
      actions.push({ kind: 'capture', groupId: event.groupId });
      current = event.groupId;
    }
  }
  return actions;
}

/**
 * `detachedGroupIds` after an admin changes the connected group from `disconnected` to
 * `connected` (either may be `null`): the old group is remembered, the new one forgotten.
 * Oldest entries drop off past `LINE_DETACHED_GROUP_IDS_MAX`.
 */
export function nextDetachedGroupIds(
  previous: readonly string[] | null | undefined,
  disconnected: string | null,
  connected: string | null,
): string[] {
  const list = (previous ?? []).filter((id) => id !== disconnected && id !== connected);
  if (disconnected) list.push(disconnected);
  return list.slice(-LINE_DETACHED_GROUP_IDS_MAX);
}

/**
 * Origin LINE must call. `PUBLIC_API_URL` wins; otherwise the admin request's own
 * origin (`X-Forwarded-Proto`/`X-Forwarded-Host` behind a proxy, else `Host`).
 */
export function resolvePublicApiBase(
  publicApiUrl: string | null | undefined,
  request: { headers: Record<string, string | string[] | undefined>; protocol?: string | null },
): string {
  const configured = (publicApiUrl ?? '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  const first = (value: string | string[] | undefined): string =>
    (Array.isArray(value) ? value[0] : value ?? '').split(',')[0].trim();
  const proto = first(request.headers['x-forwarded-proto']) || request.protocol || 'http';
  const host = first(request.headers['x-forwarded-host']) || first(request.headers.host) || 'localhost';
  return `${proto}://${host}`;
}

export function buildLineWebhookUrl(base: string, webhookKey: string): string {
  return `${base.replace(/\/+$/, '')}/${LINE_WEBHOOK_PATH}/${webhookKey}`;
}

/** `••••` + the last 4 characters (just `••••` for very short values). */
export function maskSecret(value: string | null | undefined): string {
  const text = (value ?? '').trim();
  return text.length > 8 ? `••••${text.slice(-4)}` : '••••';
}
