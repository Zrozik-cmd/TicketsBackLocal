import { Injectable } from '@nestjs/common';
import { organizerPayoutModel } from '../schemas/organizer-payout.schema';
import {
  FINANCE_CURRENCIES,
  FinanceCurrency,
  FinanceEventBalances,
  FinanceEventRecord,
  PayoutSource,
  PayoutStatus,
} from '../types/finance.types';
import { FinancePayoutGroup, composeEventBalances } from '../utils/finance-balances.util';
import { roundRate } from '../utils/finance-money.util';
import { normalizeOrderCurrency } from '../utils/finance-provider.util';
import {
  FinanceEventSalesSummary,
  FinanceRefundRetainedRow,
  FinanceSalesRow,
  FinanceUpcomingShowsRow,
  NO_SALES_FILTER,
  currencyRateFromSums,
  summarizeEventSales,
} from '../utils/finance-sales-summary.util';
import { FinanceCashService, FinanceCashState } from './finance-cash.service';
import { FinanceDirectoryService } from './finance-directory.service';
import { FinanceSalesService } from './finance-sales.service';

/** Всё, что нужно для балансов набора событий, прочитанное за один проход. */
export type FinanceSnapshot = {
  rowsByEvent: Map<number, FinanceSalesRow[]>;
  /** Удержанное провайдерами по завершённым онлайн-возвратам — только для баланса провайдеров. */
  refundRetainedByEvent: Map<number, FinanceRefundRetainedRow[]>;
  /** Оплаченное на непрошедшие показы регулярных событий — замораживается. */
  upcomingByEvent: Map<number, FinanceUpcomingShowsRow>;
  payoutGroups: FinancePayoutGroup[];
  cash: FinanceCashState;
};

/**
 * Балансы событий (spec §1.6) и курсы (spec §1.3). Переиспользуется админской
 * доской и кабинетом организатора; от сервиса выплат не зависит (наоборот —
 * выплаты спрашивают баланс здесь), поэтому итоги выплат читает сам.
 */
@Injectable()
export class FinanceBalancesService {
  constructor(
    private readonly directory: FinanceDirectoryService,
    private readonly sales: FinanceSalesService,
    private readonly cash: FinanceCashService,
  ) {}

  private get payoutModel() {
    return organizerPayoutModel();
  }

  /** Итоги ВСЕХ выплат (коллекция маленькая): событие × статус × источник × валюта. */
  async loadPayoutGroups(): Promise<FinancePayoutGroup[]> {
    const rows = await this.payoutModel
      .aggregate<{
        _id: { eventId: number; status: PayoutStatus; source: PayoutSource | null; currency: string };
        count: number;
        amount: number;
        amountThb: number;
      }>([
        {
          $group: {
            _id: { eventId: '$eventId', status: '$status', source: '$source', currency: '$currency' },
            count: { $sum: 1 },
            amount: { $sum: '$amount' },
            amountThb: { $sum: '$amountThb' },
          },
        },
      ])
      .exec();
    return rows.map((row) => ({
      eventId: Number(row._id.eventId),
      status: row._id.status,
      source: row._id.source ?? null,
      currency: normalizeOrderCurrency(row._id.currency),
      count: row.count,
      amount: Number(row.amount) || 0,
      amountThb: Number(row.amountThb) || 0,
    }));
  }

  /**
   * Продажи событий + выплаты + наличные — по одному чтению на каждое.
   * `cash: 'event'` (ровно одно событие) — наличные только по кассам этого события
   * (FinanceCashService.computeEventCashState) вместо проигрыша всего журнала.
   */
  async loadSnapshot(eventIds: number[], options: { cash?: 'all' | 'event' } = {}): Promise<FinanceSnapshot> {
    const eventCashOnly = options.cash === 'event' && eventIds.length === 1;
    const [rows, retainedRows, upcomingRows, payoutGroups, cash] = await Promise.all([
      this.sales.aggregateSalesRows(eventIds),
      this.sales.aggregateRefundRetained(eventIds),
      this.sales.aggregateUpcomingShows(eventIds),
      this.loadPayoutGroups(),
      eventCashOnly ? this.cash.computeEventCashState(eventIds[0]) : this.cash.computeCashState(),
    ]);
    const rowsByEvent = new Map<number, FinanceSalesRow[]>();
    for (const row of rows) {
      const list = rowsByEvent.get(row.eventId) ?? [];
      list.push(row);
      rowsByEvent.set(row.eventId, list);
    }
    const refundRetainedByEvent = new Map<number, FinanceRefundRetainedRow[]>();
    for (const row of retainedRows) {
      const list = refundRetainedByEvent.get(row.eventId) ?? [];
      list.push(row);
      refundRetainedByEvent.set(row.eventId, list);
    }
    const upcomingByEvent = new Map<number, FinanceUpcomingShowsRow>();
    for (const row of upcomingRows) upcomingByEvent.set(row.eventId, row);
    return { rowsByEvent, refundRetainedByEvent, upcomingByEvent, payoutGroups, cash };
  }

  static salesOf(snapshot: FinanceSnapshot, event: FinanceEventRecord, filter = NO_SALES_FILTER): FinanceEventSalesSummary {
    return summarizeEventSales(snapshot.rowsByEvent.get(event.id) ?? [], event.fees, filter);
  }

  static balancesOf(
    snapshot: FinanceSnapshot,
    event: FinanceEventRecord,
    sales: FinanceEventSalesSummary,
  ): FinanceEventBalances {
    return composeEventBalances(
      event.id,
      sales,
      snapshot.payoutGroups,
      FinanceCashService.eventCash(snapshot.cash, event.id),
      snapshot.refundRetainedByEvent.get(event.id) ?? [],
      snapshot.upcomingByEvent.get(event.id) ?? null,
      FinanceCashService.eventHeldOrders(snapshot.cash, event.id),
    );
  }

  /**
   * Текущий баланс события (без проверки владения — это дело вызывающего).
   * По id события без документа — 404 `finance_event_not_found`.
   */
  async computeEventBalances(eventOrId: number | FinanceEventRecord): Promise<FinanceEventBalances> {
    const event =
      typeof eventOrId === 'number' ? await this.directory.findEventRecord(eventOrId) : eventOrId;
    const snapshot = await this.loadSnapshot([event.id], { cash: 'event' });
    return FinanceBalancesService.balancesOf(snapshot, event, FinanceBalancesService.salesOf(snapshot, event));
  }

  /**
   * Курсы THB за единицу: по оплатам события, если они есть в валюте, иначе
   * глобальный за 90 дней, иначе null. THB = 1.
   */
  async computeRates(
    eventId: number,
    sales?: FinanceEventSalesSummary,
  ): Promise<Record<FinanceCurrency, number | null>> {
    let summary = sales;
    if (!summary) {
      const rows = await this.sales.aggregateSalesRows([eventId]);
      summary = summarizeEventSales(
        rows,
        { platformPercent: 0, processingPercent: 0, platformRate: 0, processingRate: 0 },
        NO_SALES_FILTER,
      );
    }
    const rates: Record<FinanceCurrency, number | null> = { THB: 1, RUB: null, USDT: null, KZT: null };
    let global: Record<FinanceCurrency, number | null> | null = null;
    for (const currency of FINANCE_CURRENCIES) {
      if (currency === 'THB') continue;
      const own = currencyRateFromSums(summary.rateSums[currency]);
      if (own !== null) {
        rates[currency] = roundRate(own);
        continue;
      }
      global ??= await this.sales.globalRates();
      rates[currency] = global[currency];
    }
    return rates;
  }
}
