/**
 * Group message texts. Pure (no Nest, no mongoose): every input is a plain structural
 * shape, so the builders can be exercised on their own.
 *
 * Language is English. Localized names are picked en → th → ru. Session and event
 * dates/times are stored as ICT (Asia/Bangkok) wall-clock strings and printed as such.
 */
import {
  LINE_TEXT_MAX_LENGTH,
  REVIEW_MESSAGE_MAX_LENGTH,
} from '../constants/event-messengers.constants';

export type LocalizedTextLike = { en?: string | null; th?: string | null; ru?: string | null } | null | undefined;

export type MessageEventLike = {
  id: number;
  title?: LocalizedTextLike;
  recurrence?: { enabled?: boolean | null } | null;
  eventDate?: { startDate?: string | null; isRange?: boolean | null; endDate?: string | null } | null;
  time?: { allDay?: boolean | null; start?: string | null } | null;
  sectors?: Array<{
    id: string;
    name?: LocalizedTextLike;
    zones?: Array<{ id: string; name?: LocalizedTextLike }> | null;
  }> | null;
};

export type MessageOrderLineLike = {
  sectorId: string;
  zoneId: string;
  count: number;
  session?: number | null;
  sessionDate?: string | null;
  sessionStart?: string | null;
};

export type MessageOrderLike = {
  id: number;
  total_price: number;
  paymentCurrency?: string | null;
  paymentMethod?: string | null;
  originalPaidAmount?: number | null;
  promoCodeId?: string | null;
  tickets?: MessageOrderLineLike[] | null;
};

export type MessageBuyerLike = { fullname?: string | null; email?: string | null; phone?: string | null } | null | undefined;

const DASH = '—';
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** First non-empty of en → th → ru, else `fallback`. */
export function pickEnglishText(value: LocalizedTextLike, fallback: string): string {
  for (const key of ['en', 'th', 'ru'] as const) {
    const text = value?.[key]?.trim();
    if (text) return text;
  }
  return fallback;
}

export function eventTitleOf(event: Pick<MessageEventLike, 'id' | 'title'>): string {
  return pickEnglishText(event.title, `Event #${event.id}`);
}

/**
 * Cuts `text` to at most `max` UTF-16 units, ending with `…`, never splitting a
 * surrogate pair (an emoji half would make LINE reject the message).
 */
export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return text.slice(0, Math.max(max, 0));
  let cut = max - 1;
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return `${text.slice(0, cut)}…`;
}

/** Fits a message into LINE's text limit. */
export function fitLineText(text: string): string {
  return truncateText(text, LINE_TEXT_MAX_LENGTH);
}

/** `2026-09-20` → `Sun, 20 Sep 2026` (the stored string when unreadable). */
export function formatShowDate(date: string | null | undefined, withYear = true): string {
  const raw = (date ?? '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.slice(0, 10));
  if (!m) return raw || DASH;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return raw;
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  return `${weekday}, ${day} ${MONTHS[month - 1]}${withYear ? ` ${year}` : ''}`;
}

/** `Sun, 20 Sep 2026 · 20:00`. */
export function formatShowDateTime(date: string | null | undefined, start: string | null | undefined, withYear = true): string {
  const clock = (start ?? '').trim();
  const day = formatShowDate(date, withYear);
  return clock ? `${day} · ${clock}` : day;
}

/** One-off event: `Sun, 20 Sep 2026 · 20:00`, `… · All day`, or a date range. */
export function formatOneOffSchedule(event: Pick<MessageEventLike, 'eventDate' | 'time'>): string {
  const startDate = event.eventDate?.startDate?.trim();
  if (!startDate) return DASH;
  const endDate = event.eventDate?.endDate?.trim();
  const isRange = event.eventDate?.isRange === true && !!endDate && endDate !== startDate;
  const days = isRange ? `${formatShowDate(startDate)} – ${formatShowDate(endDate)}` : formatShowDate(startDate);
  const clock = event.time?.allDay ? 'All day' : event.time?.start?.trim() ?? '';
  return clock ? `${days} · ${clock}` : days;
}

/** Distinct `(sessionDate, sessionStart)` of an order's lines, chronological. */
export function orderSessionSlots(lines: MessageOrderLineLike[]): Array<{ date: string; start: string }> {
  const seen = new Map<string, { date: string; start: string }>();
  for (const line of lines) {
    const date = line.sessionDate?.trim();
    if (!date) continue;
    const start = line.sessionStart?.trim() ?? '';
    seen.set(`${date} ${start}`, { date, start });
  }
  return [...seen.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, slot]) => slot);
}

/** `1,070` or `1,284.50` (integers without decimals). */
export function formatAmount(value: number | null | undefined): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0';
  const integer = Math.round(n * 100) % 100 === 0;
  return n.toLocaleString('en-US', {
    minimumFractionDigits: integer ? 0 : 2,
    maximumFractionDigits: integer ? 0 : 2,
  });
}

/** `total_price` is always THB; non-THB payments add the amount actually charged. */
export function formatOrderAmount(order: MessageOrderLike): string {
  const base = `${formatAmount(order.total_price)} THB`;
  const currency = (order.paymentCurrency ?? '').trim().toUpperCase();
  const original = Number(order.originalPaidAmount);
  if (!currency || currency === 'THB' || !(Number(order.total_price) > 0) || !(original > 0)) return base;
  return `${base} (≈ ${formatAmount(original)} ${currency})`;
}

export function formatPaymentMethod(order: MessageOrderLike): string {
  if (!(Number(order.total_price) > 0)) {
    return order.promoCodeId ? 'Free (100% promo)' : 'Free';
  }
  switch (order.paymentMethod) {
    case 'CASH':
      return 'Cash';
    case 'CARD':
      return 'Card (Omise)';
    case 'QR':
      return 'Thai QR (PromptPay)';
    case 'ALIPAY':
      return 'Alipay';
    case 'SVP':
      return 'SBP (RUB)';
    case 'CRYPTO':
      return 'Crypto (USDT)';
    default:
      break;
  }
  switch ((order.paymentCurrency ?? '').toUpperCase()) {
    case 'RUB':
      return 'SBP (RUB)';
    case 'USDT':
      return 'Crypto (USDT)';
    case 'KZT':
      return 'Card (KZT)';
    case 'THB':
      return 'Bank transfer (THB)';
    default:
      return order.paymentCurrency?.trim() || DASH;
  }
}

/** `Sector / Zone`; the zone alone when the sector has no name; ids when neither has one. */
export function ticketLineLabel(line: Pick<MessageOrderLineLike, 'sectorId' | 'zoneId'>, event: Pick<MessageEventLike, 'sectors'>): string {
  const sector = event.sectors?.find((item) => item.id === line.sectorId);
  const zone = sector?.zones?.find((item) => item.id === line.zoneId);
  const sectorName = pickEnglishText(sector?.name, '');
  const zoneName = pickEnglishText(zone?.name, '');
  if (sectorName && zoneName) return `${sectorName} / ${zoneName}`;
  return zoneName || sectorName || `${line.sectorId}/${line.zoneId}`;
}

function valueOrDash(value: string | null | undefined): string {
  return value?.trim() || DASH;
}

export function buildOrderPaidMessage(input: {
  order: MessageOrderLike;
  event: MessageEventLike;
  buyer: MessageBuyerLike;
  ticketCodes: string[];
}): string {
  const { order, event, buyer } = input;
  const lines = order.tickets ?? [];
  const recurring = event.recurrence?.enabled === true;
  const slots = orderSessionSlots(lines);
  const multiSession = slots.length > 1;

  const out = ['🎟 New ticket sale', `Event: ${eventTitleOf(event)}`];
  if (multiSession) {
    out.push('Shows:', ...slots.map((slot) => `• ${formatShowDateTime(slot.date, slot.start)}`));
  } else if (slots.length === 1) {
    out.push(`Show: ${formatShowDateTime(slots[0].date, slots[0].start)}`);
  } else {
    out.push(`Show: ${recurring ? DASH : formatOneOffSchedule(event)}`);
  }
  out.push(`Order: #${order.id}`, 'Tickets:');
  if (!lines.length) {
    out.push(`• ${DASH}`);
  }
  for (const line of lines) {
    const session =
      multiSession && line.sessionDate ? ` (${formatShowDateTime(line.sessionDate, line.sessionStart, false)})` : '';
    out.push(`• ${ticketLineLabel(line, event)} × ${line.count}${session}`);
  }
  const codes = input.ticketCodes.map((code) => code?.trim()).filter(Boolean);
  out.push(
    `Amount: ${formatOrderAmount(order)}`,
    `Payment: ${formatPaymentMethod(order)}`,
    `Buyer: ${valueOrDash(buyer?.fullname)}`,
    `Email: ${valueOrDash(buyer?.email)}`,
    `Phone: ${valueOrDash(buyer?.phone)}`,
    `Ticket codes: ${codes.length ? codes.join(', ') : DASH}`,
  );
  return fitLineText(out.join('\n'));
}

export function buildSessionsCancelledMessage(input: {
  event: Pick<MessageEventLike, 'id' | 'title'>;
  /** Chronological; `id` is printed only when the session could not be read. */
  sessions: Array<{ id: number; date?: string | null; start?: string | null }>;
  affectedPaidOrders: number;
}): string {
  const many = input.sessions.length > 1;
  const shows = input.sessions
    .map((session) => (session.date ? formatShowDateTime(session.date, session.start) : `Show #${session.id}`))
    .join(', ');
  return fitLineText(
    [
      many ? '❌ Shows cancelled' : '❌ Show cancelled',
      `Event: ${eventTitleOf(input.event)}`,
      `${many ? 'Shows' : 'Show'}: ${shows || DASH}`,
      `Paid orders affected: ${Math.max(0, Math.trunc(Number(input.affectedPaidOrders) || 0))}`,
    ].join('\n'),
  );
}

export function buildSalesChangedMessage(input: {
  event: Pick<MessageEventLike, 'id' | 'title'>;
  open: boolean;
  reason: string;
}): string {
  return fitLineText(
    [
      input.open ? '🟢 Sales opened' : '🔴 Sales closed',
      `Event: ${eventTitleOf(input.event)}`,
      `Reason: ${input.reason?.trim() || DASH}`,
    ].join('\n'),
  );
}

/** `★★★★☆ (4/5)`; the rating is clamped to 1…5. */
export function formatRating(rating: number): string {
  const value = Math.min(5, Math.max(1, Math.round(Number(rating) || 1)));
  return `${'★'.repeat(value)}${'☆'.repeat(5 - value)} (${value}/5)`;
}

export function buildReviewCreatedMessage(input: {
  event: Pick<MessageEventLike, 'id' | 'title'>;
  review: { authorName?: string | null; rating: number; message?: string | null };
}): string {
  const message = truncateText((input.review.message ?? '').trim(), REVIEW_MESSAGE_MAX_LENGTH);
  return fitLineText(
    [
      '⭐ New review (awaiting moderation)',
      `Event: ${eventTitleOf(input.event)}`,
      `Rating: ${formatRating(input.review.rating)}`,
      `Author: ${valueOrDash(input.review.authorName)}`,
      `"${message}"`,
    ].join('\n'),
  );
}

export function buildTestMessage(event: Pick<MessageEventLike, 'id' | 'title'>): string {
  return fitLineText(`✅ Lotus Arena test message for ${eventTitleOf(event)}`);
}
