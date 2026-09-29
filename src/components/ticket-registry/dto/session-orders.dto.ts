import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import type { EventSessionStatus } from '../../event-sessions/schemas/event-session.schema';
import type {
  MockOrderPaymentCurrency,
  RefundStatus,
} from '../../mock-orders/schemas/mock-order.schema';
import {
  optionalQueryString,
  TICKET_REGISTRY_LOCALES,
  type TicketRegistryLocale,
} from './ticket-registry.dto';

export const SESSION_ORDERS_STATUS_FILTERS = ['all', 'paid', 'refunded', 'pending_cash'] as const;
export type SessionOrdersStatusFilter = (typeof SESSION_ORDERS_STATUS_FILTERS)[number];

/** GET /events/private/:id/sessions/:sessionId/orders */
export class SessionOrdersQueryDto {
  /** Order number (exact), booking code, buyer e-mail / name / phone. */
  @IsOptional()
  @Transform(({ value }) => optionalQueryString(value))
  @IsString()
  @MaxLength(100)
  search?: string;

  /** `paid` also covers orders whose refund is in progress: their status is still `paid`. */
  @IsOptional()
  @Transform(({ value }) => optionalQueryString(value))
  @IsIn([...SESSION_ORDERS_STATUS_FILTERS])
  status?: SessionOrdersStatusFilter;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100000)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  /** Language of sector and zone names. */
  @IsOptional()
  @Transform(({ value }) => optionalQueryString(value))
  @IsIn([...TICKET_REGISTRY_LOCALES])
  locale?: TicketRegistryLocale;
}

/**
 * - `paid`         — paid, tickets issued (a refund may be in progress, see `refundStatus`).
 * - `refunded`     — refund completed; the tickets were deleted, the order keeps a snapshot.
 * - `pending_cash` — cash booking not paid at the till yet; no tickets issued.
 */
export type SessionOrderStatus = 'paid' | 'refunded' | 'pending_cash';

/**
 * sent     — `sessionCancellationNotifiedFor` contains this session.
 * queued   — paid order, not sent yet, no failed attempt: the notifier sends it within minutes.
 * retrying — paid order, 1..MAX-1 failed attempts (lastError set): will be retried.
 * failed   — paid order, attempts ≥ MAX: the notifier gave up.
 * not_sent — nobody will send it automatically: the order is not `paid` (cash booking, refunded before the letter),
 *            or the session date is older than the notifier's look-back window.
 */
export type SessionCancellationEmailState = 'sent' | 'queued' | 'retrying' | 'failed' | 'not_sent';

export interface SessionOrderTicketLine {
  sectorName: string;
  zoneName: string;
  price: number;
  count: number;
}

export interface SessionOrderRow {
  orderId: number;
  status: SessionOrderStatus;
  refundStatus: RefundStatus;
  /** ISO — order creation (there is no separate payment time for online payments). */
  createdAt: string | null;
  /** ISO — set by a cash confirmation only. */
  paymentConfirmedAt: string | null;
  /** Language of the buyer's e-mails. */
  locale: 'en' | 'ru' | 'th' | null;
  buyer: { customerId: number; name: string | null; email: string | null; phone: string | null };
  payment: {
    /** Raw `paymentMethod`: 'SVP' | 'QR' | 'CRYPTO' | 'CASH' | 'ALIPAY' | 'CARD' | null. */
    method: string | null;
    methodLabel: string;
    currency: MockOrderPaymentCurrency;
    /** Order `total_price` (THB, fees included) — the whole order, every session. */
    totalPrice: number;
    /** Order `price` (THB ticket subtotal) — the whole order. */
    ticketsPrice: number;
    /** Charged in `currency`. */
    originalPaidAmount: number | null;
    promocodeDiscount: number | null;
    vat: number;
    additionalTicketCostFee: number;
    bankCardFee: number;
    cashFee: number;
    bookingCode: string | null;
    selectedPos: string | null;
    actualPos: string | null;
    cashierEmail: string | null;
  };
  sessionTickets: {
    /** Tickets of THIS session in the order (its lines, or the refund snapshot). */
    count: number;
    /** Σ price × count of this session's lines, THB. */
    amount: number;
    /** Grouped by sector + zone + price. */
    lines: SessionOrderTicketLine[];
    /** Ticket codes of this session; none for a cash booking (nothing issued yet). */
    codes: string[];
  };
  /** Tickets of the same order on other sessions (a multi-show order). */
  otherSessionsTicketCount: number;
  refund: {
    amount: number | null;
    currency: string | null;
    createdAt: string | null;
    completedAt: string | null;
  } | null;
  ticketEmail: { status: 'pending' | 'sent' | 'failed' | null; lastSentAt: string | null };
  /** `null` unless the session is cancelled. */
  cancellationEmail: {
    state: SessionCancellationEmailState;
    attempts: number;
    lastError: string | null;
  } | null;
}

export interface SessionOrdersSummary {
  orders: number;
  /** Orders with status `paid`, refunds in progress included. */
  paidOrders: number;
  /** The part of `paidOrders` whose refund is in progress. */
  refundInProgressOrders: number;
  refundedOrders: number;
  pendingCashOrders: number;
  /** Unique customers across all orders of the session. */
  buyers: number;
  /** This session's tickets on paid orders. */
  tickets: number;
  /** This session's tickets on pending cash bookings. */
  pendingCashTickets: number;
  /** This session's tickets in refund snapshots. */
  refundedTickets: number;
  /** Σ this session's line amounts on paid orders, THB. */
  ticketsAmount: number;
  /** `null` unless the session is cancelled. */
  cancellationEmails: {
    sent: number;
    queued: number;
    retrying: number;
    failed: number;
    notSent: number;
  } | null;
}

export interface SessionOrdersResponse {
  session: { id: number; date: string; start: string; end: string; status: EventSessionStatus };
  /** Over every order of the session — search, status filter and paging do not change it. */
  summary: SessionOrdersSummary;
  items: SessionOrderRow[];
  total: number;
  page: number;
  limit: number;
}
