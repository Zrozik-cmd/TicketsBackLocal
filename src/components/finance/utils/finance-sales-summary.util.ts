import {
  FinanceCurrency,
  FinanceDailySales,
  FinanceFeeRates,
  FinanceFeesBreakdown,
  FinanceMoney,
  FinanceProvider,
  FinanceSalesFilter,
} from '../types/finance.types';
import { addDays, daysBetween, emptyByProvider, emptyMoney, round2, splitOrganizerMoney } from './finance-money.util';

/**
 * Одна строка агрегата продаж: оплаченные заказы события, сгруппированные по
 * провайдеру × валюте × ICT-дню продажи. Всё остальное (фильтры, комиссии,
 * баланс) считается из этих строк в памяти — один агрегат на всю доску.
 */
export type FinanceSalesRow = {
  eventId: number;
  provider: FinanceProvider;
  currency: FinanceCurrency;
  /** ICT-день soldAt; '' если даты нет. */
  day: string;
  orders: number;
  tickets: number;
  /** Σ total_price, THB. */
  totalPrice: number;
  /** Σ price (после промо, до НДС) — база выручки организатора. */
  price: number;
  vat: number;
  service: number;
  cardFee: number;
  cashFee: number;
  /** Σ суммы в валюте оплаты (THB → total_price, иначе originalPaidAmount > 0). */
  grossCurrency: number;
  /** Не-THB заказы с total_price > 0 без originalPaidAmount. */
  missingOriginal: number;
  /** Для курса: Σ total_price и Σ originalPaidAmount заказов, где оба > 0. */
  rateThb: number;
  rateOriginal: number;
  /** Σ price заказов со статусом возврата refund_in_progress. */
  refundInProgressPrice: number;
};

/**
 * Завершённые возвраты онлайн-заказов (ARBI Pay / Omise) события × провайдер.
 * Lotus не возвращает деньги через провайдера, поэтому у него остаётся как минимум
 * удержанная комиссия (возврат клиенту считается выплаченным со счёта провайдера).
 * Входит только в оценку баланса провайдера — продажи, комиссии и чистая выручка
 * возвраты не учитывают.
 */
export type FinanceRefundRetainedRow = {
  eventId: number;
  provider: 'arbiPay' | 'omise';
  /** Σ refund.totalCommissionTHB (не меньше 0), THB. */
  amountThb: number;
};

/**
 * Чистая выручка регулярного события, которая ещё не заработана: оплаченные заказы на
 * показы, которые не прошли (или отменены). Только доля `price` строк таких показов;
 * заказы в refund_in_progress не входят — они и так заморожены.
 */
export type FinanceUpcomingShowsRow = {
  eventId: number;
  /** Σ price-доли строк непрошедших показов, THB. */
  price: number;
  /** То же только по наличным заказам (их деньги могут ещё лежать в кассе). */
  cashPrice: number;
  /** Доля каждого наличного заказа (orderId → price-доля): часть его денег может ещё лежать в кассе. */
  cashByOrder: Map<number, number>;
};

export const NO_SALES_FILTER: FinanceSalesFilter = { currencies: [], provider: null, from: null, to: null };

export function salesRowMatches(row: FinanceSalesRow, filter: FinanceSalesFilter): boolean {
  if (filter.currencies.length && !filter.currencies.includes(row.currency)) return false;
  if (filter.provider && row.provider !== filter.provider) return false;
  if (filter.from || filter.to) {
    if (!row.day) return false;
    if (filter.from && row.day < filter.from) return false;
    if (filter.to && row.day > filter.to) return false;
  }
  return true;
}

export type FinanceDailyBucket = { tickets: number; grossThb: number };

export type FinanceEventSalesSummary = {
  /** Зависит от фильтров (валюты, провайдер, период). Не округлено. */
  filtered: {
    ticketsSold: number;
    gross: FinanceMoney;
    grossThb: number;
    fees: FinanceFeesBreakdown;
    filteredNetThb: number;
    missingOriginalOrders: number;
    ticketsByProvider: Record<FinanceProvider, number>;
    daily: Map<string, FinanceDailyBucket>;
  };
  /** Ниже — по ВСЕМ оплаченным заказам события, фильтры не влияют. */
  hasPaidOrders: boolean;
  /** Доля организатора в `price`: 1 − платформа − процессинг. */
  netShare: number;
  netThb: number;
  cashNetThb: number;
  cashTotalThb: number;
  refundInProgressNetThb: number;
  /** Часть refundInProgressNetThb по наличным заказам (их деньги ещё могут лежать в кассе). */
  cashRefundInProgressNetThb: number;
  /**
   * Сколько провайдер получил, THB = Σ total_price его заказов: ARBI Pay зачисляет мерчанту
   * `output_amount` = total_price в батах (покупатель платит рубли/USDT с комиссией ARBI
   * сверху), Omise — сумму заказа в батах. Поэтому остаток провайдера считается в батах,
   * а не в валюте покупателя.
   */
  providerReceivedThb: { arbiPay: number; omise: number };
  rateSums: Record<FinanceCurrency, { thb: number; original: number }>;
};

export function emptyFees(rates?: FinanceFeeRates): FinanceFeesBreakdown {
  return {
    platform: 0,
    platformPercent: rates?.platformPercent ?? 0,
    processing: 0,
    processingPercent: rates?.processingPercent ?? 0,
    processingByProvider: emptyByProvider(),
    vat: 0,
    service: 0,
    cardFee: 0,
    cashFee: 0,
    total: 0,
  };
}

/** Комиссии, чистая выручка и деньги события (spec §1.2, §1.6, §1.8). */
export function summarizeEventSales(
  rows: FinanceSalesRow[],
  rates: FinanceFeeRates,
  filter: FinanceSalesFilter,
): FinanceEventSalesSummary {
  const netShare = 1 - rates.platformRate - rates.processingRate;
  const fees = emptyFees(rates);
  const filtered = {
    ticketsSold: 0,
    gross: emptyMoney(),
    grossThb: 0,
    fees,
    filteredNetThb: 0,
    missingOriginalOrders: 0,
    ticketsByProvider: emptyByProvider(),
    daily: new Map<string, FinanceDailyBucket>(),
  };
  const summary: FinanceEventSalesSummary = {
    filtered,
    hasPaidOrders: false,
    netShare,
    netThb: 0,
    cashNetThb: 0,
    cashTotalThb: 0,
    refundInProgressNetThb: 0,
    cashRefundInProgressNetThb: 0,
    providerReceivedThb: { arbiPay: 0, omise: 0 },
    rateSums: { THB: { thb: 0, original: 0 }, RUB: { thb: 0, original: 0 }, USDT: { thb: 0, original: 0 }, KZT: { thb: 0, original: 0 } },
  };

  let priceAll = 0;
  let priceFiltered = 0;
  const priceByProvider = emptyByProvider();
  for (const row of rows) {
    if (row.orders > 0) summary.hasPaidOrders = true;
    priceAll += row.price;
    summary.refundInProgressNetThb += row.refundInProgressPrice * netShare;
    if (row.provider === 'cash') {
      summary.cashNetThb += row.price * netShare;
      summary.cashTotalThb += row.totalPrice;
      summary.cashRefundInProgressNetThb += row.refundInProgressPrice * netShare;
    }
    if (row.provider === 'arbiPay' || row.provider === 'omise') {
      summary.providerReceivedThb[row.provider] += row.totalPrice;
    }
    summary.rateSums[row.currency].thb += row.rateThb;
    summary.rateSums[row.currency].original += row.rateOriginal;

    if (!salesRowMatches(row, filter)) continue;
    priceFiltered += row.price;
    priceByProvider[row.provider] += row.price;
    filtered.ticketsSold += row.tickets;
    filtered.gross[row.currency] += row.grossCurrency;
    filtered.grossThb += row.totalPrice;
    filtered.missingOriginalOrders += row.missingOriginal;
    filtered.ticketsByProvider[row.provider] += row.tickets;
    fees.vat += row.vat;
    fees.service += row.service;
    fees.cardFee += row.cardFee;
    fees.cashFee += row.cashFee;
    if (row.day) {
      const bucket = filtered.daily.get(row.day) ?? { tickets: 0, grossThb: 0 };
      bucket.tickets += row.tickets;
      bucket.grossThb += row.totalPrice;
      filtered.daily.set(row.day, bucket);
    }
  }
  // Net and the platform/processing fees: one rounding rule (splitOrganizerMoney) everywhere.
  summary.netThb = splitOrganizerMoney(priceAll, rates).net;
  const split = splitOrganizerMoney(priceFiltered, rates);
  fees.platform = split.platform;
  fees.processing = split.processing;
  filtered.filteredNetThb = split.net;
  for (const provider of Object.keys(priceByProvider) as Array<keyof typeof priceByProvider>) {
    fees.processingByProvider[provider] = priceByProvider[provider] * rates.processingRate;
  }
  fees.total = fees.platform + fees.processing + fees.vat + fees.service + fees.cardFee + fees.cashFee;
  return summary;
}

/** Округлённые комиссии; итог — сумма уже округлённых частей (сходится с тем, что показано). */
export function roundFees(fees: FinanceFeesBreakdown): FinanceFeesBreakdown {
  const platform = round2(fees.platform);
  const processing = round2(fees.processing);
  const vat = round2(fees.vat);
  const service = round2(fees.service);
  const cardFee = round2(fees.cardFee);
  const cashFee = round2(fees.cashFee);
  return {
    platform,
    platformPercent: fees.platformPercent,
    processing,
    processingPercent: fees.processingPercent,
    processingByProvider: {
      arbiPay: round2(fees.processingByProvider.arbiPay),
      omise: round2(fees.processingByProvider.omise),
      cash: round2(fees.processingByProvider.cash),
      other: round2(fees.processingByProvider.other),
    },
    vat,
    service,
    cardFee,
    cashFee,
    total: round2(platform + processing + vat + service + cardFee + cashFee),
  };
}

export function mergeDaily(target: Map<string, FinanceDailyBucket>, source: Map<string, FinanceDailyBucket>): void {
  for (const [day, bucket] of source) {
    const current = target.get(day) ?? { tickets: 0, grossThb: 0 };
    current.tickets += bucket.tickets;
    current.grossThb += bucket.grossThb;
    target.set(day, current);
  }
}

/** Непрерывный ряд дней для графика — не длиннее ~10 лет, иначе только дни с продажами. */
const MAX_DENSE_DAYS = 3660;

export function buildDailySales(
  daily: Map<string, FinanceDailyBucket>,
  filter: Pick<FinanceSalesFilter, 'from' | 'to'>,
): FinanceDailySales[] {
  const keys = [...daily.keys()].filter(Boolean).sort();
  const start = filter.from ?? keys[0];
  const end = filter.to ?? keys[keys.length - 1];
  const point = (day: string): FinanceDailySales => {
    const bucket = daily.get(day);
    return { date: day, tickets: bucket?.tickets ?? 0, grossThb: round2(bucket?.grossThb ?? 0) };
  };
  if (!start || !end || start > end) return [];
  if (daysBetween(start, end) > MAX_DENSE_DAYS) {
    return keys.filter((day) => day >= start && day <= end).map(point);
  }
  const out: FinanceDailySales[] = [];
  for (let day = start; day <= end; day = addDays(day, 1)) out.push(point(day));
  return out;
}

export function currencyRateFromSums(sums: { thb: number; original: number }): number | null {
  return sums.thb > 0 && sums.original > 0 ? sums.thb / sums.original : null;
}
