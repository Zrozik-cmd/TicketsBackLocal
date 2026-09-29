import { Injectable, NotFoundException } from '@nestjs/common';
import mongoose from 'mongoose';
import { EventsService } from '../events/events.service';
import { todayIct } from '../events/utils/ict-date.util';
import { ITicket, TicketSchema } from '../tickets/schemas/ticket.schema';
import { IMockOrder, MockOrderSchema } from '../mock-orders/schemas/mock-order.schema';
import { CustomerSchema, ICustomer } from '../customers/schemas/customer.schema';
import {
  EventSessionSchema,
  IEventSession,
} from '../event-sessions/schemas/event-session.schema';
import {
  MAX_CANCELLATION_EMAIL_ATTEMPTS,
  OWED_EMAILS_LOOKBACK_DAYS,
} from '../event-sessions/session-cancellation-notifier.service';
import {
  resolvePaymentMethodLabel,
  roundMoney,
} from '../mock-orders/utils/mock-order-refund.util';
import type { TicketRegistryLocale } from './dto/ticket-registry.dto';
import type {
  SessionCancellationEmailState,
  SessionOrderRow,
  SessionOrdersQueryDto,
  SessionOrdersResponse,
  SessionOrdersStatusFilter,
  SessionOrdersSummary,
  SessionOrderStatus,
  SessionOrderTicketLine,
} from './dto/session-orders.dto';
import { buildSectorZoneNames } from './utils/sector-zone-names.util';

const DEFAULT_PAGE_SIZE = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Ticket statuses the platform actually writes; the other enum values are never set. */
const LIVE_TICKET_STATUSES = ['ACTIVE', 'USED'];
const ORDER_LOCALES = ['en', 'ru', 'th'] as const;

/** The order fields the list needs — nothing else is read. */
const ORDER_PROJECTION = {
  _id: 0,
  id: 1,
  customer: 1,
  status: 1,
  refundStatus: 1,
  createdAt: 1,
  paymentConfirmedAt: 1,
  locale: 1,
  paymentMethod: 1,
  paymentCurrency: 1,
  total_price: 1,
  price: 1,
  originalPaidAmount: 1,
  promocodeDiscount: 1,
  vat: 1,
  additionalTicketCostFee: 1,
  bankCardFee: 1,
  cashFee: 1,
  bookingCode: 1,
  selectedPos: 1,
  actualPos: 1,
  cashierEmail: 1,
  tickets: 1,
  'refundedTickets.code': 1,
  'refundedTickets.sector': 1,
  'refundedTickets.zone': 1,
  'refundedTickets.price': 1,
  'refundedTickets.session': 1,
  'refund.status': 1,
  'refund.refundAmount': 1,
  'refund.originalCurrency': 1,
  'refund.createdAt': 1,
  'refund.completedAt': 1,
  ticketEmailStatus: 1,
  ticketEmailLastSentAt: 1,
  sessionCancellationNotifiedFor: 1,
  sessionCancellationEmailAttempts: 1,
  sessionCancellationEmailLastError: 1,
} as const;

type SessionOrderDoc = Pick<
  IMockOrder,
  | 'id'
  | 'customer'
  | 'refundStatus'
  | 'createdAt'
  | 'paymentConfirmedAt'
  | 'locale'
  | 'paymentMethod'
  | 'paymentCurrency'
  | 'total_price'
  | 'price'
  | 'originalPaidAmount'
  | 'promocodeDiscount'
  | 'vat'
  | 'additionalTicketCostFee'
  | 'bankCardFee'
  | 'cashFee'
  | 'bookingCode'
  | 'selectedPos'
  | 'actualPos'
  | 'cashierEmail'
  | 'tickets'
  | 'ticketEmailStatus'
  | 'ticketEmailLastSentAt'
  | 'sessionCancellationNotifiedFor'
  | 'sessionCancellationEmailAttempts'
  | 'sessionCancellationEmailLastError'
> & {
  status: SessionOrderStatus;
  refundedTickets?: Array<{ code: string; sector: string; zone: string; price: number; session?: number }>;
  refund?: {
    status?: string;
    refundAmount?: number;
    originalCurrency?: string;
    createdAt?: Date;
    completedAt?: Date;
  };
};

type Buyer = { name: string | null; email: string | null; phone: string | null };

/** What an order holds for the session, computed once for the summary, the filter and the row. */
type OrderShare = {
  order: SessionOrderDoc;
  buyer: Buyer;
  count: number;
  amount: number;
  lines: SessionOrderTicketLine[];
  /** Snapshot codes of a refunded order; paid orders get theirs from the live tickets. */
  refundCodes: string[];
  otherSessionsTicketCount: number;
  cancellationEmail: SessionOrderRow['cancellationEmail'];
};

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function createdMs(order: Pick<SessionOrderDoc, 'createdAt'>): number {
  const time = order.createdAt ? new Date(order.createdAt).getTime() : 0;
  return Number.isNaN(time) ? 0 : time;
}

function trimmedOrNull(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

/**
 * Buyers and orders of ONE session of a regular event (Events → Statistics → Sessions),
 * above all so the organizer can reach everyone who held tickets for a cancelled show:
 * contacts, payment and refund data, the session's own ticket lines and codes, and
 * whether the automatic cancellation letter went out.
 *
 * Listed orders: paid ones (refunds in progress included) and cash bookings holding a
 * line on the session, plus completed refunds whose ticket snapshot has one. Abandoned
 * checkouts (`wait`), `failed`, `expired` and `cancelled` orders never held tickets and
 * are left out.
 *
 * The session's orders are read whole and summarised, filtered, sorted and paged in
 * memory: one show rarely has more than a few hundred orders, and the summary must cover
 * all of them anyway, whatever the search or page.
 */
@Injectable()
export class SessionOrdersService {
  constructor(private readonly eventsService: EventsService) {}

  private get ticketModel(): mongoose.Model<ITicket> {
    return (mongoose.models.Ticket as mongoose.Model<ITicket>) ??
      mongoose.model<ITicket>('Ticket', TicketSchema);
  }

  private get mockOrderModel(): mongoose.Model<IMockOrder> {
    return (mongoose.models.MockOrder as mongoose.Model<IMockOrder>) ??
      mongoose.model<IMockOrder>('MockOrder', MockOrderSchema);
  }

  private get customerModel(): mongoose.Model<ICustomer> {
    return (mongoose.models.Customer as mongoose.Model<ICustomer>) ??
      mongoose.model<ICustomer>('Customer', CustomerSchema);
  }

  private get sessionModel(): mongoose.Model<IEventSession> {
    return (mongoose.models.EventSession as mongoose.Model<IEventSession>) ??
      mongoose.model<IEventSession>('EventSession', EventSessionSchema);
  }

  async getSessionOrders(
    eventId: number,
    sessionId: number,
    creatorId: string,
    query: SessionOrdersQueryDto,
  ): Promise<SessionOrdersResponse> {
    const event = await this.eventsService.findOwnedEventDocument(eventId, creatorId);
    const page = query.page ?? 1;
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const status: SessionOrdersStatusFilter = query.status ?? 'all';
    const locale: TicketRegistryLocale = query.locale ?? 'en';
    const search = query.search?.trim() ?? '';

    // One-off events have no sessions, so any session id of theirs is a 404 as well.
    const session = Number.isSafeInteger(sessionId)
      ? ((await this.sessionModel
          .findOne({ eventId: event.id, id: sessionId })
          .select({ id: 1, date: 1, start: 1, end: 1, status: 1 })
          .lean()
          .exec()) as Pick<IEventSession, 'id' | 'date' | 'start' | 'end' | 'status'> | null)
      : null;
    if (!session) {
      throw new NotFoundException('session_not_found');
    }

    const orders = (await this.mockOrderModel
      .find({
        event: event.id,
        $or: [
          { status: { $in: ['paid', 'pending_cash'] }, 'tickets.session': session.id },
          { status: 'refunded', 'refundedTickets.session': session.id },
        ],
      })
      .select(ORDER_PROJECTION)
      .lean()
      .exec()) as unknown as SessionOrderDoc[];

    const customers = orders.length
      ? ((await this.customerModel
          .find({ id: { $in: [...new Set(orders.map((order) => order.customer))] } })
          .select({ id: 1, fullname: 1, email: 1, phone: 1 })
          .lean()
          .exec()) as Array<Pick<ICustomer, 'id' | 'fullname' | 'email' | 'phone'>>)
      : [];
    const buyerById = new Map<number, Buyer>(
      customers.map((customer) => [
        customer.id,
        {
          name: trimmedOrNull(customer.fullname),
          email: trimmedOrNull(customer.email),
          phone: trimmedOrNull(customer.phone),
        },
      ]),
    );

    const cancelled = session.status === 'cancelled';
    // Mirrors the notifier's sweep: a cancelled show dated before this is never looked at again.
    const sweptFrom = todayIct(Date.now() - OWED_EMAILS_LOOKBACK_DAYS * DAY_MS);
    const names = buildSectorZoneNames(event, locale);
    const shares = orders.map((order) =>
      this.shareOf(order, session.id, {
        buyer: buyerById.get(order.customer) ?? { name: null, email: null, phone: null },
        names,
        cancellation: cancelled ? { swept: session.date >= sweptFrom } : null,
      }),
    );

    const filtered = shares
      .filter((share) => status === 'all' || share.order.status === status)
      .filter((share) => !search || this.matchesSearch(share, search))
      // Order ids are never reused, so (creation time, id) is a stable total order.
      .sort((a, b) => createdMs(b.order) - createdMs(a.order) || b.order.id - a.order.id);
    const pageShares = filtered.slice((page - 1) * limit, (page - 1) * limit + limit);

    return {
      session: {
        id: session.id,
        date: session.date,
        start: session.start,
        end: session.end,
        status: session.status,
      },
      summary: this.summarize(shares, cancelled),
      items: await this.toRows(pageShares, session.id),
      total: filtered.length,
      page,
      limit,
    };
  }

  private shareOf(
    order: SessionOrderDoc,
    sessionId: number,
    context: {
      buyer: Buyer;
      names: ReturnType<typeof buildSectorZoneNames>;
      cancellation: { swept: boolean } | null;
    },
  ): OrderShare {
    const { names } = context;
    // A completed refund emptied `tickets`; what the order held lives in its snapshot, one entry per ticket.
    const entries =
      order.status === 'refunded'
        ? (order.refundedTickets ?? []).map((ticket) => ({
            session: ticket.session,
            sector: ticket.sector,
            zone: ticket.zone,
            price: ticket.price,
            count: 1,
            code: ticket.code,
          }))
        : (order.tickets ?? []).map((line) => ({
            session: line.session,
            sector: line.sectorId,
            zone: line.zoneId,
            price: line.price,
            count: line.count,
            code: null as string | null,
          }));

    const lineByKey = new Map<string, SessionOrderTicketLine>();
    const refundCodes: string[] = [];
    let count = 0;
    let amount = 0;
    let otherSessionsTicketCount = 0;
    for (const entry of entries) {
      const entryCount = Number(entry.count) || 0;
      if (entry.session !== sessionId) {
        otherSessionsTicketCount += entryCount;
        continue;
      }
      const price = Number(entry.price) || 0;
      count += entryCount;
      amount += price * entryCount;
      if (entry.code) refundCodes.push(entry.code);
      const key = `${entry.sector}::${entry.zone}::${price}`;
      const line = lineByKey.get(key);
      if (line) {
        line.count += entryCount;
      } else {
        lineByKey.set(key, {
          sectorName: names.sectorName(entry.sector),
          zoneName: names.zoneName(entry.sector, entry.zone),
          price: roundMoney(price),
          count: entryCount,
        });
      }
    }

    return {
      order,
      buyer: context.buyer,
      count,
      amount: roundMoney(amount),
      lines: [...lineByKey.values()],
      refundCodes,
      otherSessionsTicketCount,
      cancellationEmail: context.cancellation
        ? this.cancellationEmailOf(order, sessionId, context.cancellation.swept)
        : null,
    };
  }

  /**
   * Where the cancellation letter of this session stands for the order, judged by the
   * same rules the notifier sends by (`SessionCancellationNotifier.owedOrdersFilter` and
   * its look-back window). The attempt counter is per order, not per session.
   */
  private cancellationEmailOf(
    order: SessionOrderDoc,
    sessionId: number,
    swept: boolean,
  ): NonNullable<SessionOrderRow['cancellationEmail']> {
    const attempts = Number(order.sessionCancellationEmailAttempts) || 0;
    const lastError = trimmedOrNull(order.sessionCancellationEmailLastError);
    let state: SessionCancellationEmailState;
    if ((order.sessionCancellationNotifiedFor ?? []).includes(sessionId)) {
      state = 'sent';
    } else if (order.status !== 'paid') {
      state = 'not_sent';
    } else if (attempts >= MAX_CANCELLATION_EMAIL_ATTEMPTS) {
      state = 'failed';
    } else if (!swept) {
      state = 'not_sent';
    } else {
      state = attempts > 0 ? 'retrying' : 'queued';
    }
    /*
     * The counters describe a letter still owed by a paid order. A delivered letter keeps
     * none of them (they can belong to another cancelled session of the same order), and
     * an order that is not paid is never mailed.
     */
    if (state === 'sent' || order.status !== 'paid') return { state, attempts: 0, lastError: null };
    return { state, attempts, lastError };
  }

  /**
   * Order number (exact), booking code, buyer e-mail / name by case-insensitive substring,
   * and phone — a digits-only search skips the separators phones are typed with
   * ("+66 81-234 5678"), as in the ticket registry.
   */
  private matchesSearch(share: OrderShare, search: string): boolean {
    const needle = search.toLowerCase();
    const { order, buyer } = share;
    if (/^\d+$/.test(search) && Number(search) === order.id) return true;
    if (order.bookingCode?.toLowerCase().includes(needle)) return true;
    if (buyer.email?.toLowerCase().includes(needle)) return true;
    if (buyer.name?.toLowerCase().includes(needle)) return true;
    if (!buyer.phone) return false;
    const digits = search.replace(/\D/g, '');
    if (/^[\d\s()+.-]+$/.test(search) && digits.length >= 3) {
      return buyer.phone.replace(/\D/g, '').includes(digits);
    }
    return buyer.phone.toLowerCase().includes(needle);
  }

  private summarize(shares: OrderShare[], cancelled: boolean): SessionOrdersSummary {
    const summary: SessionOrdersSummary = {
      orders: shares.length,
      paidOrders: 0,
      refundInProgressOrders: 0,
      refundedOrders: 0,
      pendingCashOrders: 0,
      buyers: new Set(shares.map((share) => share.order.customer)).size,
      tickets: 0,
      pendingCashTickets: 0,
      refundedTickets: 0,
      ticketsAmount: 0,
      cancellationEmails: cancelled
        ? { sent: 0, queued: 0, retrying: 0, failed: 0, notSent: 0 }
        : null,
    };
    let ticketsAmount = 0;
    for (const share of shares) {
      const { order } = share;
      if (order.status === 'paid') {
        summary.paidOrders += 1;
        if (order.refundStatus === 'refund_in_progress') summary.refundInProgressOrders += 1;
        summary.tickets += share.count;
        ticketsAmount += share.amount;
      } else if (order.status === 'refunded') {
        summary.refundedOrders += 1;
        summary.refundedTickets += share.count;
      } else {
        summary.pendingCashOrders += 1;
        summary.pendingCashTickets += share.count;
      }
      if (summary.cancellationEmails && share.cancellationEmail) {
        const { state } = share.cancellationEmail;
        summary.cancellationEmails[state === 'not_sent' ? 'notSent' : state] += 1;
      }
    }
    summary.ticketsAmount = roundMoney(ticketsAmount);
    return summary;
  }

  /** Rows of one page; live ticket codes are read for the paid orders of that page only. */
  private async toRows(shares: OrderShare[], sessionId: number): Promise<SessionOrderRow[]> {
    const paidOrderIds = shares
      .filter((share) => share.order.status === 'paid')
      .map((share) => share.order.id);
    const tickets = paidOrderIds.length
      ? ((await this.ticketModel
          .find({
            orderId: { $in: paidOrderIds },
            session: sessionId,
            status: { $in: LIVE_TICKET_STATUSES },
          })
          .select({ _id: 0, id: 1, orderId: 1, code: 1 })
          .sort({ id: 1 })
          .lean()
          .exec()) as Array<Pick<ITicket, 'id' | 'orderId' | 'code'>>)
      : [];
    const codesByOrder = new Map<number, string[]>();
    for (const ticket of tickets) {
      codesByOrder.set(ticket.orderId, [...(codesByOrder.get(ticket.orderId) ?? []), ticket.code]);
    }

    return shares.map(({ order, buyer, ...share }): SessionOrderRow => {
      const currency = order.paymentCurrency ?? 'RUB';
      const method = order.paymentMethod ?? null;
      return {
        orderId: order.id,
        status: order.status,
        refundStatus: order.refundStatus ?? 'none',
        createdAt: toIso(order.createdAt),
        paymentConfirmedAt: toIso(order.paymentConfirmedAt),
        locale: ORDER_LOCALES.find((value) => value === order.locale) ?? null,
        buyer: { customerId: order.customer, ...buyer },
        payment: {
          method,
          methodLabel: method === 'CASH' ? 'Cash' : resolvePaymentMethodLabel(currency, method ?? undefined),
          currency,
          totalPrice: roundMoney(Number(order.total_price) || 0),
          ticketsPrice: roundMoney(Number(order.price) || 0),
          originalPaidAmount:
            order.originalPaidAmount != null ? roundMoney(Number(order.originalPaidAmount) || 0) : null,
          promocodeDiscount:
            order.promocodeDiscount != null ? roundMoney(Number(order.promocodeDiscount) || 0) : null,
          vat: roundMoney(Number(order.vat) || 0),
          additionalTicketCostFee: roundMoney(Number(order.additionalTicketCostFee) || 0),
          bankCardFee: roundMoney(Number(order.bankCardFee) || 0),
          cashFee: roundMoney(Number(order.cashFee) || 0),
          bookingCode: trimmedOrNull(order.bookingCode),
          selectedPos: trimmedOrNull(order.selectedPos),
          actualPos: trimmedOrNull(order.actualPos),
          cashierEmail: trimmedOrNull(order.cashierEmail),
        },
        sessionTickets: {
          count: share.count,
          amount: share.amount,
          lines: share.lines,
          codes:
            order.status === 'refunded'
              ? share.refundCodes
              : order.status === 'paid'
                ? (codesByOrder.get(order.id) ?? [])
                : [],
        },
        otherSessionsTicketCount: share.otherSessionsTicketCount,
        // A cancelled refund leaves its snapshot on the (paid again) order: nothing is being refunded.
        refund: order.refund && order.refundStatus !== 'cancelled' && order.refund.status !== 'cancelled'
          ? {
              amount: order.refund.refundAmount != null ? roundMoney(Number(order.refund.refundAmount) || 0) : null,
              currency: trimmedOrNull(order.refund.originalCurrency),
              createdAt: toIso(order.refund.createdAt),
              completedAt: toIso(order.refund.completedAt),
            }
          : null,
        ticketEmail: {
          status: order.ticketEmailStatus ?? null,
          lastSentAt: toIso(order.ticketEmailLastSentAt),
        },
        cancellationEmail: share.cancellationEmail,
      };
    });
  }
}
