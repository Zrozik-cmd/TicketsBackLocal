import type { FinanceLiveBalanceLine } from '../types/finance.types';
import { round2 } from './finance-money.util';

export type ParsedArbiPayBalance = {
  currency: string;
  balance: number;
  balances: FinanceLiveBalanceLine[];
  fetchedAt: string | null;
};

const toAmount = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? round2(value) : null;

const toCurrency = (value: unknown): string =>
  typeof value === 'string' ? value.trim().toUpperCase() : '';

/**
 * Ответ платёжного микросервиса на GET /balance/arbi (пересказ GET /api/balance ARBI Pay):
 * `{ currency, balance, balances: [{ currency, amount }], fetchedAt }`. Суммы — до сатанга.
 * null — если ответ не такой (валюты/суммы нет или она не число).
 */
export function parseArbiPayBalanceAnswer(raw: unknown): ParsedArbiPayBalance | null {
  if (!raw || typeof raw !== 'object') return null;
  const body = raw as { currency?: unknown; balance?: unknown; balances?: unknown; fetchedAt?: unknown };
  const currency = toCurrency(body.currency);
  const balance = toAmount(body.balance);
  if (!currency || balance === null) return null;
  const balances: FinanceLiveBalanceLine[] = [];
  if (Array.isArray(body.balances)) {
    for (const row of body.balances as unknown[]) {
      const line = row as { currency?: unknown; amount?: unknown } | null;
      const lineCurrency = toCurrency(line?.currency);
      const amount = toAmount(line?.amount);
      if (lineCurrency && amount !== null) balances.push({ currency: lineCurrency, amount });
    }
  }
  const fetchedAt =
    typeof body.fetchedAt === 'string' && !Number.isNaN(Date.parse(body.fetchedAt)) ? body.fetchedAt : null;
  return { currency, balance, balances, fetchedAt };
}
