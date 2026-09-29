import { BadRequestException } from '@nestjs/common';
import {
  FINANCE_CURRENCIES,
  FinanceCurrency,
  FinanceSalesFilter,
} from '../types/finance.types';
import { isIsoDay, isProvider } from './finance-money.util';

export const FINANCE_INVALID_FILTER = 'finance_invalid_filter';

export type FinanceFilterQuery = {
  currencies?: unknown;
  provider?: unknown;
  from?: unknown;
  to?: unknown;
};

const invalid = () => new BadRequestException(FINANCE_INVALID_FILTER);

const optionalString = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw invalid();
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

/**
 * Фильтры доски (spec §1.8): `currencies=THB,RUB`, `provider`, `from`/`to`
 * (ICT-дни включительно). Пустое значение — без ограничения; любое неизвестное
 * значение — 400 `finance_invalid_filter`.
 */
export function parseFinanceFilter(query: FinanceFilterQuery | null | undefined): FinanceSalesFilter {
  const source = query ?? {};

  const rawCurrencies = source.currencies;
  const parts: string[] = [];
  if (Array.isArray(rawCurrencies)) {
    for (const item of rawCurrencies) {
      if (typeof item !== 'string') throw invalid();
      parts.push(...item.split(','));
    }
  } else if (rawCurrencies !== undefined && rawCurrencies !== null) {
    if (typeof rawCurrencies !== 'string') throw invalid();
    parts.push(...rawCurrencies.split(','));
  }
  const currencies: FinanceCurrency[] = [];
  for (const part of parts) {
    const code = part.trim().toUpperCase();
    if (!code) continue;
    if (!(FINANCE_CURRENCIES as readonly string[]).includes(code)) throw invalid();
    if (!currencies.includes(code as FinanceCurrency)) currencies.push(code as FinanceCurrency);
  }

  const providerRaw = optionalString(source.provider);
  if (providerRaw !== null && !isProvider(providerRaw)) throw invalid();

  const from = optionalString(source.from);
  const to = optionalString(source.to);
  if (from !== null && !isIsoDay(from)) throw invalid();
  if (to !== null && !isIsoDay(to)) throw invalid();
  if (from !== null && to !== null && from > to) throw invalid();

  return {
    currencies,
    provider: providerRaw !== null && isProvider(providerRaw) ? providerRaw : null,
    from,
    to,
  };
}
