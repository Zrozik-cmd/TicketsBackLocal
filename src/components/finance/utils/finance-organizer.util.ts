import type { FinanceFeeRates, OrganizerShow } from '../types/finance.types';
import { addDays, ictDay, round2, roundRate, splitOrganizerMoney } from './finance-money.util';

/**
 * Кабинет организатора (spec §3): чистые функции поверх агрегатов — тренды,
 * деньги области (событие / один показ), список показов.
 */

export const FINANCE_SESSION_NOT_FOUND = 'finance_session_not_found';

/** Тренды: последние 14 ICT-дней, от старого к новому, сегодня — последний. */
export const ORGANIZER_TREND_DAYS = 14;

/** Строка агрегата по показам: строки оплаченных заказов одного показа за один ICT-день продажи. */
export type FinanceShowSalesRow = {
  sessionId: number;
  /** ICT-день soldAt; '' если даты нет. */
  day: string;
  /** Σ count строк заказа этого показа. */
  tickets: number;
  /** Σ price заказа × доля показа в заказе (price×count строк показа / price×count всех строк). */
  price: number;
};

export type OrganizerSalesTotals = { tickets: number; price: number };

/** Показ так, как его знает статистика организатора (EventsService.sessionStatistics). */
export type OrganizerSessionInfo = { sessionId: number; date: string; start: string; status: string };

export function organizerTrendDays(now: number, length: number = ORGANIZER_TREND_DAYS): string[] {
  const today = ictDay(now);
  return Array.from({ length }, (_, index) => addDays(today, index - (length - 1)));
}

/** soldTrend[i] — билеты, проданные в ICT-день days[i]. */
export function buildSoldTrend(ticketsByDay: Map<string, number>, days: string[]): number[] {
  return days.map((day) => ticketsByDay.get(day) ?? 0);
}

/** remainingTrend[i] = ticketsRemaining + Σ soldTrend[j > i] — сколько оставалось на конец дня i. */
export function buildRemainingTrend(soldTrend: number[], ticketsRemaining: number): number[] {
  const out = new Array<number>(soldTrend.length);
  let soldLater = 0;
  for (let index = soldTrend.length - 1; index >= 0; index--) {
    out[index] = ticketsRemaining + soldLater;
    soldLater += soldTrend[index];
  }
  return out;
}

export function showTotalsBySession(rows: FinanceShowSalesRow[]): Map<number, OrganizerSalesTotals> {
  const totals = new Map<number, OrganizerSalesTotals>();
  for (const row of rows) {
    const current = totals.get(row.sessionId) ?? { tickets: 0, price: 0 };
    current.tickets += row.tickets;
    current.price += row.price;
    totals.set(row.sessionId, current);
  }
  return totals;
}

export function showTicketsByDay(rows: FinanceShowSalesRow[], sessionId: number): Map<string, number> {
  const byDay = new Map<string, number>();
  for (const row of rows) {
    if (row.sessionId !== sessionId || !row.day) continue;
    byDay.set(row.day, (byDay.get(row.day) ?? 0) + row.tickets);
  }
  return byDay;
}

/**
 * Деньги области: gross = Σ price (выручка по билетам после промо, без доплат
 * покупателя), комиссия = платформа + процессинг, как `net` в spec §1.2 — тем же
 * правилом округления, что у админки (splitOrganizerMoney): gross − комиссия = чистая.
 */
export function organizerMoney(
  price: number,
  fees: FinanceFeeRates,
): { gross: number; commissionPercent: number; commission: number; netProfit: number } {
  const split = splitOrganizerMoney(price, fees);
  return {
    gross: split.gross,
    commissionPercent: roundRate(fees.platformPercent + fees.processingPercent),
    commission: split.commission,
    netProfit: split.net,
  };
}

/**
 * Показы для выбора области: дата ≤ сегодня (ICT) и (не отменён ИЛИ есть
 * продажи), новые первыми.
 */
export function selectOrganizerShows(
  sessions: OrganizerSessionInfo[],
  totals: Map<number, OrganizerSalesTotals>,
  today: string,
): OrganizerShow[] {
  return sessions
    .filter((session) => {
      if (!(session.date <= today)) return false;
      return session.status !== 'cancelled' || (totals.get(session.sessionId)?.tickets ?? 0) > 0;
    })
    .sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      if (a.start !== b.start) return a.start < b.start ? 1 : -1;
      return b.sessionId - a.sessionId;
    })
    .map((session) => {
      const sold = totals.get(session.sessionId);
      return {
        sessionId: session.sessionId,
        date: session.date,
        start: session.start,
        sold: sold?.tickets ?? 0,
        gross: round2(sold?.price ?? 0),
      };
    });
}
