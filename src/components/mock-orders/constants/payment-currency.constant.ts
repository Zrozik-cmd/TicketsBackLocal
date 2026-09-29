/**
 * ARBIPAY: валюта списания и metadata.paymentMethod жёстко связаны.
 * @see документация ARBIPAY / микросервис оплаты
 */
export const PAYMENT_CURRENCIES = ['RUB', 'USDT', 'KZT', 'THB'] as const;
export type PaymentCurrency = (typeof PAYMENT_CURRENCIES)[number];

/** Метод 1 — СБП (RUB), 2 — крипто (USDT), 3 — карты (KZT), 5 — карта (THB), 6 — PromptPay (THB) */
export const ARBIPAY_PAYMENT_METHOD = {
  SBP_RUB: 1,
  CRYPTO_USDT: 2,
  CARD_KZT: 3,
  CARD_THB: 5,
  PROMPTPAY_THB: 6,
} as const;

/** Множитель для amount в минимальных единицах (копейки / тиыны / сатанги THB) */
const MINOR_UNIT_MULTIPLIER = 100;

export function getArbiPaymentMethod(currency: PaymentCurrency): number {
  switch (currency) {
    case 'USDT':
      return ARBIPAY_PAYMENT_METHOD.CRYPTO_USDT;
    case 'KZT':
      return ARBIPAY_PAYMENT_METHOD.CARD_KZT;
    case 'THB':
      // THB check flow is processed manually and should not call ARBIPAY.
      return ARBIPAY_PAYMENT_METHOD.SBP_RUB;
    case 'RUB':
    default:
      return ARBIPAY_PAYMENT_METHOD.SBP_RUB;
  }
}

/** Сумма заказа в основных единицах → amount для микросервиса (минимальные единицы) */
export function toMinorUnits(mainAmount: number): number {
  return Math.round(mainAmount * MINOR_UNIT_MULTIPLIER);
}
