import { ICT_OFFSET_MS } from '../../events/utils/ict-date.util';
import {
  CashFlowState,
  FINANCE_CURRENCIES,
  FINANCE_PROVIDERS,
  FinanceMoney,
  FinanceProvider,
} from '../types/finance.types';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Допуск сравнения денег: полсатанга. */
export const MONEY_EPS = 0.005;

/**
 * Деньги наружу — ровно до сатанга (суммируем неокруглённое, округляем на выходе).
 * `-0` превращаем в `0`, чтобы в JSON не уезжало `-0`.
 */
export function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const rounded = Math.round(value * 100) / 100;
  return rounded === 0 ? 0 : rounded;
}

/**
 * Σ price (THB) → комиссия платформы, процессинг и чистая выручка организатора. Каждая
 * комиссия округляется ОДИН раз, а чистая = gross − платформа − процессинг, поэтому на
 * доске, на странице события и в кабинете организатора части сходятся до сатанга.
 */
export function splitOrganizerMoney(
  price: number,
  rates: { platformRate: number; processingRate: number },
): { gross: number; platform: number; processing: number; commission: number; net: number } {
  const gross = round2(price);
  const platform = round2(price * rates.platformRate);
  const processing = round2(price * rates.processingRate);
  return { gross, platform, processing, commission: round2(platform + processing), net: round2(gross - platform - processing) };
}

/** Курс THB за единицу валюты — 6 знаков после запятой. */
export function roundRate(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 1e6) / 1e6;
}

export function emptyMoney(): FinanceMoney {
  return { THB: 0, RUB: 0, USDT: 0, KZT: 0 };
}

export function roundMoney(money: FinanceMoney): FinanceMoney {
  const out = emptyMoney();
  for (const currency of FINANCE_CURRENCIES) out[currency] = round2(money[currency]);
  return out;
}

export function addMoney(target: FinanceMoney, source: FinanceMoney): FinanceMoney {
  for (const currency of FINANCE_CURRENCIES) target[currency] += source[currency];
  return target;
}

export function emptyByProvider(): Record<FinanceProvider, number> {
  return { arbiPay: 0, omise: 0, cash: 0, other: 0 };
}

export function emptyCash(): CashFlowState {
  return { atCashier: 0, inTransit: 0, inVault: 0 };
}

export function roundCash(state: CashFlowState): CashFlowState {
  return {
    atCashier: round2(state.atCashier),
    inTransit: round2(state.inTransit),
    inVault: round2(state.inVault),
  };
}

export function isProvider(value: string): value is FinanceProvider {
  return (FINANCE_PROVIDERS as readonly string[]).includes(value);
}

/** ICT-день (UTC+7) момента `ms`, `YYYY-MM-DD`. */
export function ictDay(ms: number): string {
  return new Date(ms + ICT_OFFSET_MS).toISOString().slice(0, 10);
}

/** Начало ICT-суток дня `YYYY-MM-DD` как UTC-таймстамп. */
export function ictDayStartMs(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`) - ICT_OFFSET_MS;
}

/** Строго `YYYY-MM-DD` и реальная календарная дата. */
export function isIsoDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

export function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / DAY_MS);
}

export function toIsoOrNull(value: unknown): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value as string);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function toMs(value: unknown): number | null {
  if (value == null) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value as string).getTime();
  return Number.isFinite(ms) ? ms : null;
}
