/**
 * Ticket statuses lifecycle.
 */
export const TICKET_STATUSES = [
  'ACTIVE',
  'USED',
  'EXPIRED',
  'DECLINED',
  'RETURNED',
] as const;

export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_STATUS_DEFAULT: TicketStatus = 'ACTIVE';
