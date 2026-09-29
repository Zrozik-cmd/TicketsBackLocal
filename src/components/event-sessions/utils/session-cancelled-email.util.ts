import {
  SESSION_CANCELLED_EMAIL_LOCALES,
  type SessionCancelledEmailLocale,
} from '../locales/session-cancelled-email.locales';
import {
  buildBrandedEmailHtml,
  emailDetailRow,
  escapeEmailHtml,
} from '../../../utils/branded-email.util';

/** One order line whose session was cancelled, already resolved to display names. */
export type SessionCancelledEmailLine = {
  /** `YYYY-MM-DD`, ICT. */
  date: string;
  /** `HH:mm`, ICT. */
  start: string;
  end?: string;
  sectorName: string;
  zoneName: string;
  count: number;
};

export type SessionCancelledEmailInput = {
  locale: SessionCancelledEmailLocale;
  eventTitle: string;
  orderId: number | string;
  lines: SessionCancelledEmailLine[];
  /** Absolute logo URL; the text wordmark is used when empty. */
  logoUrl?: string;
};

/** `2026-09-15` → "15 September 2026" / "15 сентября 2026 г." / "15 กันยายน 2569". */
export function formatSessionEmailDate(date: string, locale: SessionCancelledEmailLocale): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date ?? '');
  if (!match) return date ?? '';
  const dict = SESSION_CANCELLED_EMAIL_LOCALES[locale] ?? SESSION_CANCELLED_EMAIL_LOCALES.en;
  // A calendar date, not an instant: format the UTC midnight in UTC so no zone can shift the day.
  return new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  ).toLocaleDateString(dict.dateLocale, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function fillPlaceholders(template: string, values: { title: string; date: string }): string {
  return template.replace(/\{(title|date)\}/g, (_, key: 'title' | 'date') => values[key]);
}

/**
 * Subject, plain text and branded HTML of the "your show was cancelled" letter.
 * Pure: everything it needs arrives in `input`, so it renders the same from a
 * test script as from the notifier.
 */
export function buildSessionCancelledEmail(input: SessionCancelledEmailInput): {
  subject: string;
  text: string;
  html: string;
} {
  const locale: SessionCancelledEmailLocale = SESSION_CANCELLED_EMAIL_LOCALES[input.locale]
    ? input.locale
    : 'en';
  const dict = SESSION_CANCELLED_EMAIL_LOCALES[locale];
  const lines = [...input.lines].sort((a, b) =>
    `${a.date}T${a.start}`.localeCompare(`${b.date}T${b.start}`),
  );
  const dates = [...new Set(lines.map((line) => line.date))]
    .map((date) => formatSessionEmailDate(date, locale))
    .join(', ');
  const title = input.eventTitle.trim();
  const orderNumber = `#${input.orderId}`;
  const timeOf = (line: SessionCancelledEmailLine) =>
    line.end ? `${line.start}–${line.end}` : line.start;

  const subject = fillPlaceholders(dict.subject, { title, date: dates });
  const body = fillPlaceholders(dict.body, { title, date: dates });

  const text = [
    dict.title,
    body,
    '',
    `${dict.fields.orderNumber}: ${orderNumber}`,
    `${dict.fields.event}: ${title}`,
    `${dict.fields.cancelledTickets}:`,
    ...lines.map(
      (line) =>
        `- ${formatSessionEmailDate(line.date, locale)}, ${timeOf(line)} — ${line.sectorName} / ${line.zoneName} × ${line.count}`,
    ),
    '',
    dict.footer,
  ].join('\n');

  const cell = 'padding:6px 8px;border-bottom:1px solid #f3f4f6;vertical-align:top;';
  const head =
    'padding:6px 8px;border-bottom:1px solid #e5e7eb;color:#6b7280;font-weight:600;text-align:left;';
  const linesTable = `
            <div style="font-size:14px;font-weight:600;color:#111827;margin:14px 0 6px;">${escapeEmailHtml(dict.fields.cancelledTickets)}</div>
            <table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;font-size:14px;color:#374151;">
              <tr>
                <th style="${head}">${escapeEmailHtml(dict.fields.date)}</th>
                <th style="${head}">${escapeEmailHtml(dict.fields.time)}</th>
                <th style="${head}">${escapeEmailHtml(dict.fields.sector)}</th>
                <th style="${head}">${escapeEmailHtml(dict.fields.zone)}</th>
                <th style="${head}text-align:right;">${escapeEmailHtml(dict.fields.quantity)}</th>
              </tr>
              ${lines
                .map(
                  (line) => `<tr>
                <td style="${cell}">${escapeEmailHtml(formatSessionEmailDate(line.date, locale))}</td>
                <td style="${cell}white-space:nowrap;">${escapeEmailHtml(timeOf(line))}</td>
                <td style="${cell}">${escapeEmailHtml(line.sectorName)}</td>
                <td style="${cell}">${escapeEmailHtml(line.zoneName)}</td>
                <td style="${cell}text-align:right;">${line.count}</td>
              </tr>`,
                )
                .join('')}
            </table>`;

  const html = buildBrandedEmailHtml({
    logoUrl: input.logoUrl ?? '',
    title: escapeEmailHtml(dict.title),
    subtitle: escapeEmailHtml(body),
    bodyRowsHtml: [
      emailDetailRow(escapeEmailHtml(dict.fields.orderNumber), escapeEmailHtml(orderNumber), true),
      emailDetailRow(escapeEmailHtml(dict.fields.event), escapeEmailHtml(title), true),
      linesTable,
    ].join(''),
    footer: escapeEmailHtml(dict.footer),
  });

  return { subject, text, html };
}
