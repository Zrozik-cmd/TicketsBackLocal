import {
  CashFlowState,
  FinanceCurrency,
  FinanceEventBalances,
  PayoutSource,
  PayoutStatus,
} from '../types/finance.types';
import {
  FinanceEventSalesSummary,
  FinanceRefundRetainedRow,
  FinanceUpcomingShowsRow,
} from './finance-sales-summary.util';
import { emptyCash, emptyMoney, round2, roundCash } from './finance-money.util';

/** Итоги выплат события одной группой агрегата: статус × источник × валюта. */
export type FinancePayoutGroup = {
  eventId: number;
  status: PayoutStatus;
  source: PayoutSource | null;
  currency: FinanceCurrency;
  count: number;
  amount: number;
  amountThb: number;
};

/** Наличный заказ, часть денег которого ещё не в сейфе (FIFO-проигрыш кассы). */
export type FinanceHeldCashOrder = {
  orderId: number;
  price: number;
  totalPrice: number;
  /** Деньги заказа не в сейфе: в кассе + в инкассации без квитанции, THB. */
  heldThb: number;
  /** paid (в т.ч. refund_in_progress) — деньги организатора; иначе (refunded) — удержанная комиссия, деньги платформы. */
  paid: boolean;
  refundInProgress: boolean;
};

/**
 * Заморожено по наличным, доля организатора, THB. Три причины не выплачивать:
 * деньги ещё не в офисе (в кассе или в пути), наличный заказ в refund_in_progress и
 * наличный заказ на непрошедший показ. Резерв заказа, чьи деньги ещё в кассе, уже
 * заморожен как «не в офисе» — это пересечение вычитается ПО ЗАКАЗУ:
 *   frozen = held + резервы − Σ min(резерв заказа, его деньги не в офисе),
 * не больше всей наличной чистой выручки. Деньги возвращённого заказа (удержанная
 * комиссия) — платформы, в долю организатора не входят. Деньги события без
 * известного заказа (редкость) делятся по общей доле организатора в наличных.
 */
export function cashFrozenNetThb(params: {
  netShare: number;
  cashNetThb: number;
  cashNetRatio: number;
  /** Деньги события не в офисе по FIFO (положительные части), THB. */
  eventHeldThb: number;
  heldOrders: FinanceHeldCashOrder[];
  cashRefundInProgressNetThb: number;
  upcomingCashNetThb: number;
  upcomingCashByOrder: Map<number, number>;
}): number {
  let heldOrganizer = 0;
  let heldKnown = 0;
  let overlap = 0;
  for (const order of params.heldOrders) {
    heldKnown += order.heldThb;
    if (!order.paid || !(order.totalPrice > 0)) continue;
    const net = order.price * params.netShare;
    const heldNet = Math.min(order.heldThb, order.totalPrice) * (net / order.totalPrice);
    heldOrganizer += heldNet;
    const reserved = order.refundInProgress ? net : (params.upcomingCashByOrder.get(order.orderId) ?? 0) * params.netShare;
    overlap += Math.min(reserved, heldNet);
  }
  const untraced = Math.max(params.eventHeldThb - heldKnown, 0) * params.cashNetRatio;
  const held = Math.min(heldOrganizer + untraced, params.cashNetThb);
  const frozen = held + params.cashRefundInProgressNetThb + params.upcomingCashNetThb - overlap;
  return Math.max(Math.min(frozen, params.cashNetThb), 0);
}

type GatewayProvider = FinanceRefundRetainedRow['provider'];
const GATEWAY_PROVIDERS: readonly GatewayProvider[] = ['arbiPay', 'omise'];

/**
 * Баланс события (spec §1.6): текущее состояние по ВСЕМ оплаченным заказам и
 * выплатам, фильтры доски на него не влияют. `cash` — FIFO-оценка события.
 * `refundRetained` — что осталось у провайдеров от завершённых онлайн-возвратов
 * (входит только в оценку баланса провайдеров). `upcoming` — оплаченное на показы
 * регулярного события, которые ещё не прошли. `heldOrders` — наличные заказы,
 * чьи деньги ещё не в сейфе (чтобы не заморозить их дважды).
 */
export function composeEventBalances(
  eventId: number,
  sales: FinanceEventSalesSummary,
  payouts: FinancePayoutGroup[],
  cash: CashFlowState | null | undefined,
  refundRetained: FinanceRefundRetainedRow[] = [],
  upcoming: FinanceUpcomingShowsRow | null = null,
  heldOrders: FinanceHeldCashOrder[] = [],
): FinanceEventBalances {
  const netShare = sales.netShare;

  let paidOut = 0;
  let pending = 0;
  /** Проведённые выплаты из провайдера, THB (выплату в рублях считаем по её курсу — amountThb). */
  const gatewayOutThb: Record<GatewayProvider, number> = { arbiPay: 0, omise: 0 };
  for (const group of payouts) {
    if (group.eventId !== eventId) continue;
    if (group.status === 'completed') {
      paidOut += group.amountThb;
      if (group.source === 'arbiPay' || group.source === 'omise') gatewayOutThb[group.source] += group.amountThb;
    } else if (group.status === 'pending') {
      pending += group.amountThb;
    }
  }

  const cashState = roundCash(cash ?? emptyCash());
  const cashNetRatio = sales.cashTotalThb > 0 ? sales.cashNetThb / sales.cashTotalThb : 0;
  const upcomingNetThb = (upcoming?.price ?? 0) * netShare;
  const upcomingCashNetThb = (upcoming?.cashPrice ?? 0) * netShare;
  /*
   * Заморожено = то, что организатору ещё нельзя выплатить:
   * - наличные: cashFrozenNetThb (деньги не в офисе + наличные возвраты в процессе и
   *   непрошедшие показы, без двойного счёта денег того же заказа);
   * - онлайн: заказы в refund_in_progress и заказы на непрошедшие показы (регулярные
   *   события: показ ещё может не состояться, и деньги вернутся покупателю).
   */
  const cashFrozen = cashFrozenNetThb({
    netShare,
    cashNetThb: sales.cashNetThb,
    cashNetRatio,
    eventHeldThb: Math.max(cash?.atCashier ?? 0, 0) + Math.max(cash?.inTransit ?? 0, 0),
    heldOrders,
    cashRefundInProgressNetThb: sales.cashRefundInProgressNetThb,
    upcomingCashNetThb,
    upcomingCashByOrder: upcoming?.cashByOrder ?? new Map(),
  });
  const onlineFrozen =
    sales.refundInProgressNetThb - sales.cashRefundInProgressNetThb + (upcomingNetThb - upcomingCashNetThb);
  const frozenThb = round2(cashFrozen + onlineFrozen);
  const netThb = round2(sales.netThb);
  const paidOutThb = round2(paidOut);
  const pendingPayoutsThb = round2(pending);

  /*
   * Остаток у провайдера, THB: получено (Σ total_price его заказов + удержанное с
   * завершённых возвратов) минус проведённые выплаты из него. Снятия самой платформы
   * со счёта провайдера Lotus не знает — поэтому это «деньги события у провайдера»,
   * а не живой остаток счёта.
   */
  const gateway = { arbiPay: emptyMoney(), omise: emptyMoney() };
  for (const provider of GATEWAY_PROVIDERS) {
    const retained = refundRetained
      .filter((row) => row.eventId === eventId && row.provider === provider)
      .reduce((sum, row) => sum + row.amountThb, 0);
    gateway[provider].THB = round2(sales.providerReceivedThb[provider] + retained - gatewayOutThb[provider]);
  }

  return {
    eventId,
    netThb,
    paidOutThb,
    pendingPayoutsThb,
    frozenThb,
    upcomingShowsThb: round2(upcomingNetThb),
    availableThb: round2(netThb - paidOutThb - pendingPayoutsThb - frozenThb),
    cash: cashState,
    gatewayBalance: gateway,
    cashNetRatio,
    refundInProgressNetThb: round2(sales.refundInProgressNetThb),
  };
}
