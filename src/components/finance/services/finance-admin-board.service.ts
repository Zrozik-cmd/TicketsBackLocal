import { Injectable } from '@nestjs/common';
import {
  CashFlowState,
  FinanceBoard,
  FinanceEventBalances,
  FinanceEventDetails,
  FinanceEventOption,
  FinanceEventRecord,
  FinanceEventSummary,
  FinancePayoutContext,
  FinanceSalesFilter,
} from '../types/finance.types';
import {
  MONEY_EPS,
  addMoney,
  emptyByProvider,
  emptyCash,
  emptyMoney,
  round2,
  roundCash,
  roundMoney,
} from '../utils/finance-money.util';
import {
  FinanceDailyBucket,
  FinanceEventSalesSummary,
  buildDailySales,
  emptyFees,
  mergeDaily,
  roundFees,
} from '../utils/finance-sales-summary.util';
import { FinanceBalancesService } from './finance-balances.service';
import { FinanceDirectoryService } from './finance-directory.service';
import { FinancePayoutsService } from './finance-payouts.service';

type BoardTotals = FinanceBoard['totals'];

const hasCash = (cash: CashFlowState) =>
  Math.abs(cash.atCashier) >= MONEY_EPS || Math.abs(cash.inTransit) >= MONEY_EPS || Math.abs(cash.inVault) >= MONEY_EPS;
/** Событие только с возвращёнными онлайн-заказами: у провайдера осталась удержанная комиссия. */
const hasGatewayBalance = (gateway: FinanceEventBalances['gatewayBalance']) =>
  [gateway.arbiPay, gateway.omise].some((money) => Object.values(money).some((value) => Math.abs(value) >= MONEY_EPS));

export function buildEventSummary(
  event: FinanceEventRecord,
  sales: FinanceEventSalesSummary,
  balances: FinanceEventBalances,
): FinanceEventSummary {
  return {
    id: event.id,
    title: event.title,
    date: event.date,
    kind: event.kind,
    organizer: event.organizer,
    ticketsSold: sales.filtered.ticketsSold,
    gross: roundMoney(sales.filtered.gross),
    grossThb: round2(sales.filtered.grossThb),
    fees: roundFees(sales.filtered.fees),
    filteredNetThb: round2(sales.filtered.filteredNetThb),
    netThb: balances.netThb,
    paidOutThb: balances.paidOutThb,
    pendingPayoutsThb: balances.pendingPayoutsThb,
    frozenThb: balances.frozenThb,
    upcomingShowsThb: balances.upcomingShowsThb,
    availableThb: balances.availableThb,
    cash: balances.cash,
    gatewayBalance: balances.gatewayBalance,
    missingOriginalOrders: sales.filtered.missingOriginalOrders,
  };
}

function emptyTotals(): BoardTotals {
  return {
    ticketsSold: 0,
    gross: emptyMoney(),
    grossThb: 0,
    fees: emptyFees(),
    filteredNetThb: 0,
    netThb: 0,
    paidOutThb: 0,
    pendingPayoutsThb: 0,
    frozenThb: 0,
    upcomingShowsThb: 0,
    availableThb: 0,
    overpaidThb: 0,
    cash: emptyCash(),
    gatewayBalance: { arbiPay: emptyMoney(), omise: emptyMoney() },
    missingOriginalOrders: 0,
  };
}

/**
 * Итоги = сумма показанных строк (округлённых), наличные — точные общие. «Доступно» —
 * сумма ПОЛОЖИТЕЛЬНЫХ остатков: переплата одному организатору не уменьшает то, что
 * можно выплатить другим; переплаты — отдельно (overpaidThb).
 */
function sumTotals(rows: FinanceEventSummary[], overallCash: CashFlowState): BoardTotals {
  const totals = emptyTotals();
  const byProvider = emptyByProvider();
  for (const row of rows) {
    totals.ticketsSold += row.ticketsSold;
    addMoney(totals.gross, row.gross);
    totals.grossThb += row.grossThb;
    totals.fees.platform += row.fees.platform;
    totals.fees.processing += row.fees.processing;
    for (const provider of Object.keys(byProvider) as Array<keyof typeof byProvider>) {
      byProvider[provider] += row.fees.processingByProvider[provider];
    }
    totals.fees.vat += row.fees.vat;
    totals.fees.service += row.fees.service;
    totals.fees.cardFee += row.fees.cardFee;
    totals.fees.cashFee += row.fees.cashFee;
    totals.fees.total += row.fees.total;
    totals.filteredNetThb += row.filteredNetThb;
    totals.netThb += row.netThb;
    totals.paidOutThb += row.paidOutThb;
    totals.pendingPayoutsThb += row.pendingPayoutsThb;
    totals.frozenThb += row.frozenThb;
    totals.upcomingShowsThb += row.upcomingShowsThb;
    if (row.availableThb > 0) totals.availableThb += row.availableThb;
    else totals.overpaidThb += row.availableThb;
    addMoney(totals.gatewayBalance.arbiPay, row.gatewayBalance.arbiPay);
    addMoney(totals.gatewayBalance.omise, row.gatewayBalance.omise);
    totals.missingOriginalOrders += row.missingOriginalOrders;
  }
  return {
    ...totals,
    gross: roundMoney(totals.gross),
    grossThb: round2(totals.grossThb),
    fees: roundFees({ ...totals.fees, processingByProvider: byProvider, platformPercent: 0, processingPercent: 0 }),
    filteredNetThb: round2(totals.filteredNetThb),
    netThb: round2(totals.netThb),
    paidOutThb: round2(totals.paidOutThb),
    pendingPayoutsThb: round2(totals.pendingPayoutsThb),
    frozenThb: round2(totals.frozenThb),
    upcomingShowsThb: round2(totals.upcomingShowsThb),
    availableThb: round2(totals.availableThb),
    overpaidThb: round2(totals.overpaidThb),
    cash: overallCash,
    gatewayBalance: {
      arbiPay: roundMoney(totals.gatewayBalance.arbiPay),
      omise: roundMoney(totals.gatewayBalance.omise),
    },
  };
}

/** Админская доска финансов (spec §1.7–1.8, §2): сборка из общих сервисов. */
@Injectable()
export class FinanceAdminBoardService {
  constructor(
    private readonly directory: FinanceDirectoryService,
    private readonly balances: FinanceBalancesService,
    private readonly payouts: FinancePayoutsService,
  ) {}

  async listEventOptions(): Promise<FinanceEventOption[]> {
    const events = await this.directory.listAdminEvents();
    return events.map((event) => ({
      id: event.id,
      title: event.title,
      date: event.date,
      kind: event.kind,
      organizer: event.organizer,
    }));
  }

  async getBoard(filter: FinanceSalesFilter): Promise<FinanceBoard> {
    const events = await this.directory.listAdminEvents();
    const snapshot = await this.balances.loadSnapshot(events.map((event) => event.id));
    const payoutEventIds = new Set(snapshot.payoutGroups.map((group) => group.eventId));

    const rows: FinanceEventSummary[] = [];
    const daily = new Map<string, FinanceDailyBucket>();
    const shownIds = new Set<number>();
    for (const event of events) {
      const sales = FinanceBalancesService.salesOf(snapshot, event, filter);
      const balances = FinanceBalancesService.balancesOf(snapshot, event, sales);
      if (
        !sales.hasPaidOrders &&
        !payoutEventIds.has(event.id) &&
        !hasCash(balances.cash) &&
        !hasGatewayBalance(balances.gatewayBalance)
      ) {
        continue;
      }
      rows.push(buildEventSummary(event, sales, balances));
      mergeDaily(daily, sales.filtered.daily);
      shownIds.add(event.id);
    }
    rows.sort((a, b) => b.grossThb - a.grossThb || b.id - a.id);

    // Наличные событий, не попавших в список (не должно случаться), — к «без события».
    const unattributed = { ...snapshot.cash.raw.unattributed };
    for (const [eventId, cash] of snapshot.cash.raw.byEvent) {
      if (shownIds.has(eventId)) continue;
      unattributed.atCashier += cash.atCashier;
      unattributed.inTransit += cash.inTransit;
      unattributed.inVault += cash.inVault;
    }

    return {
      events: rows,
      totals: sumTotals(rows, snapshot.cash.overall),
      unattributedCash: roundCash(unattributed),
      dailySales: buildDailySales(daily, filter),
      generatedAt: new Date().toISOString(),
    };
  }

  async getEventDetails(eventId: number, filter: FinanceSalesFilter): Promise<FinanceEventDetails> {
    const event = await this.directory.getAdminEvent(eventId);
    const [snapshot, payouts] = await Promise.all([
      this.balances.loadSnapshot([event.id], { cash: 'event' }),
      this.payouts.listEventPayouts(event.id, { from: filter.from, to: filter.to }, event.title),
    ]);
    const sales = FinanceBalancesService.salesOf(snapshot, event, filter);
    const balances = FinanceBalancesService.balancesOf(snapshot, event, sales);
    return {
      summary: buildEventSummary(event, sales, balances),
      dailySales: buildDailySales(sales.filtered.daily, filter),
      payouts,
      ticketsByProvider: { ...sales.filtered.ticketsByProvider },
    };
  }

  async getPayoutContext(eventId: number): Promise<FinancePayoutContext> {
    const event = await this.directory.getAdminEvent(eventId);
    const snapshot = await this.balances.loadSnapshot([event.id], { cash: 'event' });
    const sales = FinanceBalancesService.salesOf(snapshot, event);
    const balances = FinanceBalancesService.balancesOf(snapshot, event, sales);
    const rates = await this.balances.computeRates(event.id, sales);
    return {
      eventId: event.id,
      organizer: event.organizer,
      netThb: balances.netThb,
      paidOutThb: balances.paidOutThb,
      pendingPayoutsThb: balances.pendingPayoutsThb,
      frozenThb: balances.frozenThb,
      upcomingShowsThb: balances.upcomingShowsThb,
      availableThb: balances.availableThb,
      vaultThb: snapshot.cash.overall.inVault,
      rates,
    };
  }
}
