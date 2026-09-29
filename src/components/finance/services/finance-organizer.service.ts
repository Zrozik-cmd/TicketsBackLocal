import { Injectable, NotFoundException } from '@nestjs/common';
import { EventsService } from '../../events/events.service';
import { ManagersService } from '../../managers/managers.service';
import { financeMockOrderModel } from '../finance-models';
import {
  FinanceEventRecord,
  FinancePayoutActor,
  FinanceReceiptFile,
  OrganizerFinance,
  OrganizerPayout,
} from '../types/finance.types';
import { ictDay } from '../utils/finance-money.util';
import {
  FINANCE_SESSION_NOT_FOUND,
  FinanceShowSalesRow,
  buildRemainingTrend,
  buildSoldTrend,
  organizerMoney,
  organizerTrendDays,
  selectOrganizerShows,
  showTicketsByDay,
  showTotalsBySession,
} from '../utils/finance-organizer.util';
import { toOrganizerPayout } from '../utils/finance-payout-mapper.util';
import {
  priceShareExpr,
  sumTicketLinesExpr,
  ticketLineAmountExpr,
  ticketLineCountExpr,
} from '../utils/finance-show-share.util';
import { FinanceBalancesService } from './finance-balances.service';
import { FINANCE_EVENT_NOT_FOUND, FinanceDirectoryService } from './finance-directory.service';
import { FinancePayoutsService } from './finance-payouts.service';

/** Кто спрашивает: организатор (USER_ID_KEY) и, если вошёл менеджер, его id. */
export type OrganizerFinancePrincipal = { userId: string | number; managerId?: string | null };

type ShowSalesAggRow = { _id: { session: number; day: string | null }; tickets: number; price: number };

/**
 * Финансы события в кабинете организатора (spec §3). Формулы не дублируются:
 * продажи, балансы и выплаты — из общих сервисов финансов (как у админки),
 * остаток мест — из статистики организатора EventsService. Своё здесь только
 * деление заказов по показам для регулярных событий.
 */
@Injectable()
export class FinanceOrganizerService {
  constructor(
    private readonly directory: FinanceDirectoryService,
    private readonly balances: FinanceBalancesService,
    private readonly payouts: FinancePayoutsService,
    private readonly eventsService: EventsService,
    private readonly managersService: ManagersService,
  ) {}

  private get orderModel() {
    return financeMockOrderModel();
  }

  /** Событие этого организатора (event.creator), иначе 404 `finance_event_not_found`. */
  async getOwnedEvent(eventId: number, userId: string | number): Promise<FinanceEventRecord> {
    const event = await this.directory.findEventRecord(eventId);
    const owner = Number(userId);
    if (!event.exists || !Number.isInteger(owner) || owner < 1 || event.creator !== owner) {
      throw new NotFoundException(FINANCE_EVENT_NOT_FOUND);
    }
    return event;
  }

  async getEventFinance(
    eventId: number,
    userId: string | number,
    sessionId: number | null,
    now: number = Date.now(),
  ): Promise<OrganizerFinance> {
    const event = await this.getOwnedEvent(eventId, userId);
    const isRecurring = event.kind === 'regular';
    if (sessionId !== null && !isRecurring) throw new NotFoundException(FINANCE_SESSION_NOT_FOUND);

    const [statistics, snapshot, payouts, showRows] = await Promise.all([
      this.eventsService.getOwnerEventStatistics(String(event.id), String(event.creator)),
      this.balances.loadSnapshot([event.id], { cash: 'event' }),
      this.payouts.listEventPayouts(event.id, undefined, event.title),
      isRecurring ? this.aggregateShowSales(event.id) : Promise.resolve<FinanceShowSalesRow[]>([]),
    ]);

    const sessionStats = statistics.sessionStatistics ?? [];
    const session = sessionId === null ? null : sessionStats.find((item) => item.sessionId === sessionId);
    if (sessionId !== null && !session) throw new NotFoundException(FINANCE_SESSION_NOT_FOUND);

    // Балансы — всегда уровень события (spec §1.6), как у админки.
    const sales = FinanceBalancesService.salesOf(snapshot, event);
    const balances = FinanceBalancesService.balancesOf(snapshot, event, sales);

    let ticketsSold: number;
    let price: number;
    let ticketsByDay: Map<string, number>;
    let ticketsRemaining: number;
    const showTotals = showTotalsBySession(showRows);
    if (session) {
      const totals = showTotals.get(session.sessionId);
      ticketsSold = totals?.tickets ?? 0;
      price = totals?.price ?? 0;
      ticketsByDay = showTicketsByDay(showRows, session.sessionId);
      ticketsRemaining = session.remaining;
    } else {
      const rows = snapshot.rowsByEvent.get(event.id) ?? [];
      ticketsSold = sales.filtered.ticketsSold;
      price = rows.reduce((sum, row) => sum + row.price, 0);
      ticketsByDay = new Map<string, number>();
      for (const [day, bucket] of sales.filtered.daily) ticketsByDay.set(day, bucket.tickets);
      ticketsRemaining = statistics.ticketsRemainingToBuy;
    }

    const soldTrend = buildSoldTrend(ticketsByDay, organizerTrendDays(now));
    const shows = isRecurring
      ? selectOrganizerShows(
          sessionStats.map((item) => ({
            sessionId: item.sessionId,
            date: item.date,
            start: item.start,
            status: item.status,
          })),
          showTotals,
          ictDay(now),
        )
      : [];

    return {
      event: { id: event.id, title: event.title, isRecurring },
      sessionId: session ? session.sessionId : null,
      ticketsSold,
      ticketsRemaining,
      soldTrend,
      remainingTrend: buildRemainingTrend(soldTrend, ticketsRemaining),
      ...organizerMoney(price, event.fees),
      paidOut: balances.paidOutThb,
      inProcess: balances.pendingPayoutsThb,
      frozen: balances.frozenThb,
      upcomingShows: balances.upcomingShowsThb,
      available: Math.max(balances.availableThb, 0),
      payouts: payouts.map(toOrganizerPayout),
      shows,
    };
  }

  /** Запрос выплаты (pending, THB) — правила и проверка доступного в FinancePayoutsService. */
  async requestPayout(
    eventId: number,
    principal: OrganizerFinancePrincipal,
    input: { amount: number; note?: string | null },
  ): Promise<OrganizerPayout> {
    const event = await this.getOwnedEvent(eventId, principal.userId);
    const actor = await this.resolveActor(event, principal);
    const payout = await this.payouts.createOrganizerRequest({
      eventId: event.id,
      amount: input.amount,
      note: input.note ?? '',
      actor,
    });
    return toOrganizerPayout(payout);
  }

  /** Квитанция выплаты своего события; выплата обязана принадлежать этому событию. */
  async getReceiptFile(
    eventId: number,
    userId: string | number,
    payoutId: number,
    receiptId: number,
  ): Promise<FinanceReceiptFile> {
    const event = await this.getOwnedEvent(eventId, userId);
    return this.payouts.getReceiptFile(payoutId, receiptId, event.id);
  }

  /**
   * Продажи регулярного события по показам: каждый оплаченный заказ делится на
   * показы долей строк — Σ(price×count строк показа) / Σ(price×count всех строк),
   * при бесплатных строках — долей count (то же правило, что `periodShareExpr`
   * статистики). Билеты показа — Σ count его строк. Группировка показ × ICT-день продажи.
   */
  async aggregateShowSales(eventId: number): Promise<FinanceShowSalesRow[]> {
    const soldAt = { $ifNull: ['$paymentConfirmedAt', '$createdAt'] };
    const lineAmount = ticketLineAmountExpr;
    const lineCount = ticketLineCountExpr;
    const sumLines = sumTicketLinesExpr;

    const rows = await this.orderModel
      .aggregate<ShowSalesAggRow>([
        { $match: { event: eventId, status: 'paid', 'tickets.session': { $type: 'number' } } },
        {
          $project: {
            price: { $ifNull: ['$price', 0] },
            day: { $dateToString: { format: '%Y-%m-%d', date: soldAt, timezone: '+07:00' } },
            tickets: 1,
            totalAmount: sumLines(lineAmount('$$line')),
            totalCount: sumLines(lineCount('$$line')),
          },
        },
        { $unwind: '$tickets' },
        { $match: { 'tickets.session': { $type: 'number' } } },
        {
          $group: {
            _id: { order: '$_id', session: '$tickets.session' },
            day: { $first: '$day' },
            price: { $first: '$price' },
            totalAmount: { $first: '$totalAmount' },
            totalCount: { $first: '$totalCount' },
            lineAmount: { $sum: lineAmount('$tickets') },
            lineCount: { $sum: lineCount('$tickets') },
          },
        },
        {
          $project: {
            _id: 0,
            session: '$_id.session',
            day: 1,
            tickets: '$lineCount',
            price: {
              $multiply: ['$price', priceShareExpr('$lineAmount', '$lineCount', '$totalAmount', '$totalCount')],
            },
          },
        },
        {
          $group: {
            _id: { session: '$session', day: '$day' },
            tickets: { $sum: '$tickets' },
            price: { $sum: '$price' },
          },
        },
      ])
      .exec();

    return rows.map((row) => ({
      sessionId: Number(row._id.session),
      day: row._id.day ?? '',
      tickets: Number(row.tickets) || 0,
      price: Number(row.price) || 0,
    }));
  }

  /** Подпись в истории: email организатора; менеджер — его email или название. */
  private async resolveActor(
    event: FinanceEventRecord,
    principal: OrganizerFinancePrincipal,
  ): Promise<FinancePayoutActor> {
    if (principal.managerId) {
      const manager = await this.managersService.findById(String(principal.managerId));
      const id = Number(principal.managerId);
      const label = (manager?.email ?? '').trim() || (manager?.title ?? '').trim() || `manager#${principal.managerId}`;
      return { kind: 'manager', id: Number.isInteger(id) ? id : 0, label };
    }
    const id = Number(principal.userId);
    return {
      kind: 'organizer',
      id: Number.isInteger(id) ? id : 0,
      label: event.organizer.email || `user#${principal.userId}`,
    };
  }
}
