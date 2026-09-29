import { ICT_OFFSET_MS } from '../../../components/events/utils/ict-date.util';

/*
 * Order dates printed on a ticket, as the Bangkok (ICT) wall clock whatever the server's own
 * time zone: `new Date().getDate()` on a UTC or European host prints the day before for an
 * order paid after midnight in Thailand.
 */

/** `YYYY-MM-DDTHH:MM...` of the instant in ICT, or `''` when `value` is not a date. */
function toIctIso(value?: string | Date): string {
  if (!value) return '';
  const ms = (value instanceof Date ? value : new Date(value)).getTime();
  if (Number.isNaN(ms)) return '';
  return new Date(ms + ICT_OFFSET_MS).toISOString();
}

/** `DD.MM.YYYY` in ICT, or `''`. */
export function formatTicketDate(value?: string | Date): string {
  const iso = toIctIso(value);
  return iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : '';
}

/** `DD.MM.YYYY HH:MM` in ICT, or `''`. */
export function formatTicketDateTime(value?: string | Date): string {
  const iso = toIctIso(value);
  return iso ? `${formatTicketDate(value)} ${iso.slice(11, 16)}` : '';
}
