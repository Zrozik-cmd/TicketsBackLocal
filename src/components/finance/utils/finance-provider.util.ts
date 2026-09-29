import { FINANCE_CURRENCIES, FinanceCurrency, FinanceProvider } from '../types/finance.types';

/**
 * Провайдер заказа (spec §1.1) — кто держит деньги заказа. Нигде не хранится, выводится
 * из полей заказа:
 *
 * - `CASH` — касса;
 * - `ALIPAY` — только Omise (у ARBI Pay его нет);
 * - `CARD` / `QR` (карта / PromptPay, THB) — ДВА провайдера по времени: до переключения
 *   оформление шло в Omise, после — в ARBI Pay (Omise-оформление удалено тем же релизом,
 *   поэтому граница точная). Граница — `ARBIPAY_THB_SINCE` (см. ниже) по `createdAt` заказа:
 *   заказ, созданный старым кодом, остаётся Omise, даже если оплату подтвердили уже после релиза;
 * - RUB / USDT / KZT — ARBI Pay (у этих оплат `paymentMethod` не выставляется, их отличает
 *   только валюта);
 * - бесплатный заказ по 100%-промокоду записан как RUB — поэтому проверка `total_price <= 0`
 *   стоит ДО проверки валюты.
 */
export const OMISE_ONLY_PAYMENT_METHODS = ['ALIPAY'] as const;
/** Карта и PromptPay (THB): Omise до `ARBIPAY_THB_SINCE`, ARBI Pay после. */
export const THB_GATEWAY_PAYMENT_METHODS = ['CARD', 'QR'] as const;
export const ARBIPAY_CURRENCIES = ['RUB', 'USDT', 'KZT'] as const;

/**
 * ARBIPAY_THB_SINCE — момент, с которого оплата картой и PromptPay (THB) идёт через ARBI Pay,
 * а не через Omise. Заказы CARD/QR, созданные РАНЬШЕ, — Omise; с этого момента — ARBI Pay.
 *
 * Откуда число: переход на ARBI Pay (коммит 4869d70 «Introduce ARBI Pay THB integration»,
 * PR #87) попал в прод вместе с PR #89 «Merge pull request #89 from ARBI-Main/dev» —
 * merge-коммит e600c1b в `main`, 2026-09-23 12:43:46 +03:00 = 09:43:46 UTC. Прод-деплой
 * (.github/workflows/deploy.yml) запускается этим push в `main`.
 *
 * Известные неточности:
 * - пока шёл деплой (несколько минут после мержа), ещё работал старый код с Omise: карта/PromptPay,
 *   оформленные в это окно, будут посчитаны как ARBI Pay. Для точности до секунды поставить сюда
 *   `createdAt` первой THB-транзакции карты/PromptPay в прод-базе платёжного микросервиса;
 * - на dev переход был раньше (PR #87 в `dev` — 2026-09-18 12:10:09 +03:00), поэтому на dev
 *   заказы картой/PromptPay с 18.09 по 23.09 (тестовые) показываются как Omise.
 *
 * Менять только если Omise снова вернётся в оформление — тогда нужна уже явная пометка
 * провайдера на заказе, а не дата.
 */
export const ARBIPAY_THB_SINCE = new Date('2026-09-23T09:43:46.000Z');

export type ProviderClassifiable = {
  paymentMethod?: string | null;
  paymentCurrency?: string | null;
  total_price?: number | null;
  createdAt?: Date | string | null;
};

export function classifyOrderProvider(
  order: ProviderClassifiable,
  arbipayThbSince: Date = ARBIPAY_THB_SINCE,
): FinanceProvider {
  const method = order.paymentMethod ?? null;
  if (method === 'CASH') return 'cash';
  if (method && (OMISE_ONLY_PAYMENT_METHODS as readonly string[]).includes(method)) return 'omise';
  if (method && (THB_GATEWAY_PAYMENT_METHODS as readonly string[]).includes(method)) {
    const createdAt = order.createdAt == null ? NaN : new Date(order.createdAt).getTime();
    return Number.isFinite(createdAt) && createdAt >= arbipayThbSince.getTime() ? 'arbiPay' : 'omise';
  }
  if ((Number(order.total_price) || 0) <= 0) return 'other';
  if ((ARBIPAY_CURRENCIES as readonly string[]).includes(order.paymentCurrency ?? '')) return 'arbiPay';
  return 'other';
}

/** То же правило, что `classifyOrderProvider`, как выражение агрегации. */
export function financeProviderExpr(arbipayThbSince: Date = ARBIPAY_THB_SINCE) {
  return {
    $switch: {
      branches: [
        { case: { $eq: ['$paymentMethod', 'CASH'] }, then: 'cash' },
        { case: { $in: [{ $ifNull: ['$paymentMethod', null] }, [...OMISE_ONLY_PAYMENT_METHODS]] }, then: 'omise' },
        {
          case: { $in: [{ $ifNull: ['$paymentMethod', null] }, [...THB_GATEWAY_PAYMENT_METHODS]] },
          then: {
            $cond: [{ $gte: [{ $ifNull: ['$createdAt', new Date(0)] }, arbipayThbSince] }, 'arbiPay', 'omise'],
          },
        },
        { case: { $lte: [{ $ifNull: ['$total_price', 0] }, 0] }, then: 'other' },
        { case: { $in: [{ $ifNull: ['$paymentCurrency', null] }, [...ARBIPAY_CURRENCIES]] }, then: 'arbiPay' },
      ],
      default: 'other',
    },
  };
}

/**
 * Валюта заказа для денежных корзин. Поле обязательно в схеме, но у документов
 * без него (или с неизвестным значением) деньги считаются THB — `total_price`
 * всегда хранится в батах.
 */
export function normalizeOrderCurrency(value: unknown): FinanceCurrency {
  return (FINANCE_CURRENCIES as readonly unknown[]).includes(value) ? (value as FinanceCurrency) : 'THB';
}

/** То же правило, что `normalizeOrderCurrency`, как выражение агрегации. */
export const FINANCE_CURRENCY_EXPR = {
  $cond: [
    { $in: [{ $ifNull: ['$paymentCurrency', null] }, [...FINANCE_CURRENCIES]] },
    '$paymentCurrency',
    'THB',
  ],
};
