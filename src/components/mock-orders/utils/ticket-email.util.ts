/*
 * The "your tickets" letter: the buyer's e-mail, its manual resend and the organizer
 * copy (`event.ticketCopyEmail`). Pure string builders — the ticket attachments (WebP or
 * PDF, `resolveTicketAttachmentFormat`) are rendered and added by the caller — so a
 * letter can be rendered from a plain script.
 */
import { escapeEmailHtml } from '../../../utils/branded-email.util';
import type { EventTicketFormat, IEventSponsor } from '../../events/schemas/event.schema';
import { isSponsorHttpUrl } from '../../events/utils/event-sponsors.util';
import { TICKET_EMAIL_LOCALES, type TicketEmailLocale } from '../locales/ticket-email.locales';

export type TicketEmailTexts = (typeof TICKET_EMAIL_LOCALES)[TicketEmailLocale];

/**
 * Format of an order's ticket attachments: the event's `ticketFormat` (absent = 'webp').
 * Also 'pdf' whenever an approved sponsor printed on the ticket has a link: a WebP image
 * cannot carry a clickable link. The organizer form enforces that for the list it submits;
 * this covers approved links still live while a pending list without links awaits review.
 */
export function resolveTicketAttachmentFormat(event: {
  ticketFormat?: EventTicketFormat | null;
  sponsors?: Array<Pick<IEventSponsor, 'url'>> | null;
}): EventTicketFormat {
  if (event.ticketFormat === 'pdf') return 'pdf';
  const hasLink = (event.sponsors ?? []).some(
    (sponsor) => typeof sponsor?.url === 'string' && isSponsorHttpUrl(sponsor.url.trim()),
  );
  return hasLink ? 'pdf' : 'webp';
}

/**
 * Most a letter's PDF tickets may weigh once base64-encoded (`mimeBase64Size`). A PDF ticket
 * embeds the cover and the sponsor logos (downscaled, still ~0.1–0.8 MB a ticket), so a big
 * order could outgrow a relay's or a mailbox's size cap and the whole letter would be refused;
 * above this budget the letter carries WebP tickets instead (no clickable links, but the
 * tickets arrive).
 */
export const TICKET_EMAIL_PDF_MAX_ENCODED_BYTES = 10 * 1024 * 1024;

/** Size of `bytes` as a base64 MIME part: 4 characters per 3 bytes, CRLF after every 76. */
export function mimeBase64Size(bytes: number): number {
  const chars = Math.ceil(bytes / 3) * 4;
  return chars + 2 * Math.ceil(chars / 76);
}

/** File name and MIME type of one attached ticket: `ticket-{orderId}-{ticketId}.{webp|pdf}`. */
export function ticketAttachmentFile(
  format: EventTicketFormat,
  orderId: number,
  ticketId: number,
): { filename: string; contentType: string } {
  return format === 'pdf'
    ? { filename: `ticket-${orderId}-${ticketId}.pdf`, contentType: 'application/pdf' }
    : { filename: `ticket-${orderId}-${ticketId}.webp`, contentType: 'image/webp' };
}

/**
 * The organizer copy is English whatever the buyer's locale — the letter and the
 * attached tickets alike (the caller renders the tickets with this locale).
 */
export const TICKET_COPY_LOCALE: TicketEmailLocale = 'en';

export function buildTicketsEmail(params: {
  dict: TicketEmailTexts;
  eventTitle: string;
  buyerName: string;
  buyerEmail: string;
  /** Absolute URL of the logo, or `''` for the text wordmark. */
  logoUrl: string;
  /** Extra first line of the letter — the organizer copy names the order and the buyer. */
  preface?: string;
  /** Format of the attached tickets; picks the subtitle that names it. */
  ticketFormat: EventTicketFormat;
}): { subject: string; text: string; html: string } {
  const { dict } = params;
  const subtitle = params.ticketFormat === 'pdf' ? dict.subtitlePdf : dict.subtitle;
  const eventTitle = escapeEmailHtml(params.eventTitle);
  const brand = params.logoUrl
    ? `<img src="${params.logoUrl}" alt="Lotus Arena" style="height:32px;display:block;margin-bottom:12px;" />`
    : '<div style="font-size:18px;font-weight:700;margin-bottom:12px;">Lotus Arena</div>';
  const preface = params.preface
    ? `
        <div style="max-width:640px;margin:0 auto 12px;font-size:14px;color:#111827;">${escapeEmailHtml(params.preface)}</div>`
    : '';
  const html = `
      <div style="font-family:Arial,sans-serif;background:#f3f4f6;padding:24px;">${preface}
        <div style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e5e7eb;">
          <div style="padding:20px;background:linear-gradient(90deg,#FAB67E 0%,#F48874 16%,#EF5880 32%,#E0185F 48%,#B13187 64%,#3E7BB8 82%,#5268AE 100%);color:#ffffff;">
            ${brand}
            <div style="font-size:24px;font-weight:700;line-height:1.2;">${dict.title}</div>
            <div style="font-size:14px;opacity:.95;margin-top:8px;">${subtitle}</div>
          </div>
          <div style="padding:20px;color:#111827;">
            <div style="font-size:15px;font-weight:600;margin-bottom:8px;">${dict.fields.event}: ${eventTitle}</div>
            <div style="font-size:14px;color:#4b5563;margin-bottom:14px;">${dict.fields.buyer}: ${escapeEmailHtml(params.buyerName)} (${escapeEmailHtml(params.buyerEmail)})</div>
            <div style="font-size:12px;color:#6b7280;">${dict.footer}</div>
          </div>
        </div>
      </div>`;
  const text = `${dict.title}. ${dict.fields.event}: ${params.eventTitle}`;
  return {
    subject: `${dict.subject} - ${params.eventTitle}`,
    text: params.preface ? `${params.preface}\n\n${text}` : text,
    html,
  };
}

/**
 * First line of the organizer copy, always English:
 * `Copy of the tickets for order #{orderId}. Buyer: {fullname} <{email}>{, phone}`.
 */
export function buildTicketCopyPreface(
  orderId: number,
  buyer: { fullname?: string | null; email?: string | null; phone?: string | null },
  fallbackName: string,
): string {
  const name = buyer.fullname?.trim() || fallbackName;
  const email = buyer.email?.trim() ?? '';
  const phone = buyer.phone?.trim() ?? '';
  return `Copy of the tickets for order #${orderId}. Buyer: ${name} <${email}>${phone ? `, ${phone}` : ''}`;
}

/**
 * The organizer copy (`event.ticketCopyEmail`) of an order's tickets letter. Takes no
 * locale on purpose: subject, texts and preface are English, and the event title is
 * picked English first (then Thai, then Russian), so the buyer's `order.locale` can
 * never leak into it.
 */
export function buildTicketCopyEmail(params: {
  orderId: number;
  event: { id: number; title?: { en?: string; th?: string; ru?: string } | null };
  buyer: { id: number; fullname?: string | null; email?: string | null; phone?: string | null };
  /** Absolute URL of the logo, or `''` for the text wordmark. */
  logoUrl: string;
  /** Format of the attached tickets (`resolveTicketAttachmentFormat`). */
  ticketFormat: EventTicketFormat;
}): { subject: string; text: string; html: string } {
  const { orderId, event, buyer } = params;
  const title = event.title ?? {};
  const eventTitle =
    [title.en, title.th, title.ru].map((value) => value?.trim()).find(Boolean) ||
    `Event #${event.id}`;
  const fallbackName = `Customer #${buyer.id}`;
  return buildTicketsEmail({
    dict: TICKET_EMAIL_LOCALES[TICKET_COPY_LOCALE],
    eventTitle,
    buyerName: buyer.fullname?.trim() || fallbackName,
    buyerEmail: buyer.email?.trim() ?? '',
    logoUrl: params.logoUrl,
    preface: buildTicketCopyPreface(orderId, buyer, fallbackName),
    ticketFormat: params.ticketFormat,
  });
}
