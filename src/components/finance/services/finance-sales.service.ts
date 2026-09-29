import { Injectable } from '@nestjs/common';
import { financeEventSessionModel, financeMockOrderModel } from '../finance-models';
import { FINANCE_CURRENCIES, FinanceCurrency } from '../types/finance.types';
import { ictDay, roundRate } from '../utils/finance-money.util';
import { ARBIPAY_CURRENCIES, FINANCE_CURRENCY_EXPR, financeProviderExpr } from '../utils/finance-provider.util';
import {
  FinanceRefundRetainedRow,
  FinanceSalesRow,
  FinanceUpcomingShowsRow,
  currencyRateFromSums,
} from '../utils/finance-sales-summary.util';
import { FinanceShowInfo, isShowOver, showsPriceShareStages } from '../utils/finance-show-share.util';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Окно глобального курса, если у события нет своих оплат в валюте. */
export const FINANCE_GLOBAL_RATE_DAYS = 90;

type SalesAggRow = {
  _id: { event: number; provider: FinanceSalesRow['provider']; currency: FinanceCurrency; day: string | null };
} & Omit<FinanceSalesRow, 'eventId' | 'provider' | 'currency' | 'day'>;

/**
 * Продажи из заказов: ОДИН агрегат по индексу {event, status} на весь набор
 * событий, сгруппированный по событию × провайдеру × валюте × ICT-дню.
 */
@Injectable()
export class FinanceSalesService {
  private get orderModel() {
    return financeMockOrderModel();
  }

  private get sessionModel() {
    return financeEventSessionModel();
  }

  /** Выражение провайдера заказа (карта/PromptPay: Omise до ARBIPAY_THB_SINCE, ARBI Pay после). */
  providerExpr() {
    return financeProviderExpr();
  }

  /** Оплаченные заказы событий (`null` — всех событий). Возвраты (refunded) не входят. */
  async aggregateSalesRows(eventIds: number[] | null): Promise<FinanceSalesRow[]> {
    if (eventIds && !eventIds.length) return [];
    const soldAt = { $ifNull: ['$paymentConfirmedAt', '$createdAt'] };
    const bothPositive = { $and: [{ $gt: ['$original', 0] }, { $gt: ['$totalPrice', 0] }] };
    const rows = await this.orderModel
      .aggregate<SalesAggRow>([
        { $match: { ...(eventIds ? { event: { $in: eventIds } } : {}), status: 'paid' } },
        {
          $project: {
            _id: 0,
            event: 1,
            provider: this.providerExpr(),
            currency: FINANCE_CURRENCY_EXPR,
            day: { $dateToString: { format: '%Y-%m-%d', date: soldAt, timezone: '+07:00' } },
            tickets: { $sum: '$tickets.count' },
            totalPrice: { $ifNull: ['$total_price', 0] },
            price: { $ifNull: ['$price', 0] },
            vat: { $ifNull: ['$vat', 0] },
            service: { $ifNull: ['$additionalTicketCostFee', 0] },
            cardFee: { $ifNull: ['$bankCardFee', 0] },
            cashFee: { $ifNull: ['$cashFee', 0] },
            original: { $ifNull: ['$originalPaidAmount', 0] },
            refundInProgress: { $eq: ['$refundStatus', 'refund_in_progress'] },
          },
        },
        {
          $group: {
            _id: { event: '$event', provider: '$provider', currency: '$currency', day: '$day' },
            orders: { $sum: 1 },
            tickets: { $sum: '$tickets' },
            totalPrice: { $sum: '$totalPrice' },
            price: { $sum: '$price' },
            vat: { $sum: '$vat' },
            service: { $sum: '$service' },
            cardFee: { $sum: '$cardFee' },
            cashFee: { $sum: '$cashFee' },
            grossCurrency: {
              $sum: {
                $cond: [
                  { $eq: ['$currency', 'THB'] },
                  '$totalPrice',
                  { $cond: [{ $gt: ['$original', 0] }, '$original', 0] },
                ],
              },
            },
            missingOriginal: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $ne: ['$currency', 'THB'] },
                      { $gt: ['$totalPrice', 0] },
                      { $not: [{ $gt: ['$original', 0] }] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
            rateThb: { $sum: { $cond: [bothPositive, '$totalPrice', 0] } },
            rateOriginal: { $sum: { $cond: [bothPositive, '$original', 0] } },
            refundInProgressPrice: { $sum: { $cond: ['$refundInProgress', '$price', 0] } },
          },
        },
      ])
      .exec();

    return rows.map((row) => ({
      eventId: Number(row._id.event),
      provider: row._id.provider,
      currency: row._id.currency,
      day: row._id.day ?? '',
      orders: row.orders,
      tickets: row.tickets,
      totalPrice: row.totalPrice,
      price: row.price,
      vat: row.vat,
      service: row.service,
      cardFee: row.cardFee,
      cashFee: row.cashFee,
      grossCurrency: row.grossCurrency,
      missingOriginal: row.missingOriginal,
      rateThb: row.rateThb,
      rateOriginal: row.rateOriginal,
      refundInProgressPrice: row.refundInProgressPrice,
    }));
  }

  /**
   * Завершённые возвраты онлайн-заказов (`null` — всех событий): что осталось у
   * провайдера — удержанная комиссия `refund.totalCommissionTHB` (без снимка возврата — 0).
   * Тот же индекс {event, status}.
   */
  async aggregateRefundRetained(eventIds: number[] | null): Promise<FinanceRefundRetainedRow[]> {
    if (eventIds && !eventIds.length) return [];
    const rows = await this.orderModel
      .aggregate<{ _id: { event: number; provider: FinanceRefundRetainedRow['provider'] }; amountThb: number }>([
        { $match: { ...(eventIds ? { event: { $in: eventIds } } : {}), status: 'refunded' } },
        {
          $project: {
            _id: 0,
            event: 1,
            provider: this.providerExpr(),
            retained: { $max: [{ $ifNull: ['$refund.totalCommissionTHB', 0] }, 0] },
          },
        },
        { $match: { provider: { $in: ['arbiPay', 'omise'] } } },
        { $group: { _id: { event: '$event', provider: '$provider' }, amountThb: { $sum: '$retained' } } },
      ])
      .exec();
    return rows.map((row) => ({
      eventId: Number(row._id.event),
      provider: row._id.provider,
      amountThb: Number(row.amountThb) || 0,
    }));
  }

  /**
   * Регулярные события: оплаченное на показы, которые ещё не прошли или отменены
   * (`isShowOver`). Доля `price` заказа по строкам таких показов; заказы в
   * refund_in_progress не входят (они заморожены отдельно). По событию: всё и только наличные.
   */
  async aggregateUpcomingShows(eventIds: number[] | null, now: number = Date.now()): Promise<FinanceUpcomingShowsRow[]> {
    if (eventIds && !eventIds.length) return [];
    // Кандидаты: отменённые и те, что начинаются не раньше вчерашнего ICT-дня (показ через полночь).
    const sessions = await this.sessionModel
      .find({
        ...(eventIds ? { eventId: { $in: eventIds } } : {}),
        $or: [{ status: 'cancelled' }, { date: { $gte: ictDay(now - DAY_MS) } }],
      })
      .select({ id: 1, date: 1, start: 1, end: 1, status: 1 })
      .lean<FinanceShowInfo[]>()
      .exec();
    const pendingIds = sessions.filter((session) => !isShowOver(session, now)).map((session) => session.id);
    if (!pendingIds.length) return [];

    const rows = await this.orderModel
      .aggregate<{ _id: { event: number; cash: boolean }; price: number; cashOrders?: Array<{ orderId: number; price: number }> }>([
        {
          $match: {
            ...(eventIds ? { event: { $in: eventIds } } : {}),
            status: 'paid',
            refundStatus: { $ne: 'refund_in_progress' },
            'tickets.session': { $in: pendingIds },
          },
        },
        ...showsPriceShareStages(pendingIds),
      ])
      .exec();

    const byEvent = new Map<number, FinanceUpcomingShowsRow>();
    for (const row of rows) {
      const eventId = Number(row._id.event);
      const current = byEvent.get(eventId) ?? { eventId, price: 0, cashPrice: 0, cashByOrder: new Map<number, number>() };
      const price = Number(row.price) || 0;
      current.price += price;
      if (row._id.cash) {
        current.cashPrice += price;
        for (const order of row.cashOrders ?? []) current.cashByOrder.set(Number(order.orderId), Number(order.price) || 0);
      }
      byEvent.set(eventId, current);
    }
    return [...byEvent.values()];
  }

  /**
   * Глобальный курс THB за единицу по оплатам последних 90 дней (spec §1.3):
   * Σ total_price / Σ originalPaidAmount, где обе суммы > 0.
   */
  async globalRates(now: number = Date.now()): Promise<Record<FinanceCurrency, number | null>> {
    const since = new Date(now - FINANCE_GLOBAL_RATE_DAYS * DAY_MS);
    const rows = await this.orderModel
      .aggregate<{ _id: FinanceCurrency; thb: number; original: number }>([
        {
          $match: {
            status: 'paid',
            paymentCurrency: { $in: [...ARBIPAY_CURRENCIES] },
            originalPaidAmount: { $gt: 0 },
            total_price: { $gt: 0 },
          },
        },
        { $match: { $expr: { $gte: [{ $ifNull: ['$paymentConfirmedAt', '$createdAt'] }, since] } } },
        { $group: { _id: '$paymentCurrency', thb: { $sum: '$total_price' }, original: { $sum: '$originalPaidAmount' } } },
      ])
      .exec();
    const rates: Record<FinanceCurrency, number | null> = { THB: 1, RUB: null, USDT: null, KZT: null };
    for (const row of rows) {
      if (!(FINANCE_CURRENCIES as readonly string[]).includes(row._id) || row._id === 'THB') continue;
      const rate = currencyRateFromSums({ thb: row.thb, original: row.original });
      rates[row._id] = rate === null ? null : roundRate(rate);
    }
    return rates;
  }
}
