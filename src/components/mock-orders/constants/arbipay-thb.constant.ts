/**
 * Card and PromptPay (THB) are paid on ARBI Pay's own pages (ARBI Pay runs Omise behind them),
 * reached through the payment microservice like SBP / USDT. The checkout still sends the
 * method in the legacy wire field `omisePaymentMethod` so older clients keep working.
 * Alipay is gone: ARBI Pay does not offer it.
 */
export const ARBIPAY_THB_METHODS = ['card', 'promptpay'] as const;
export type ArbipayThbMethod = (typeof ARBIPAY_THB_METHODS)[number];

/** Stable error codes (the frontend translates them). */
export const ARBIPAY_THB_ERRORS = {
  /** A method ARBI Pay does not offer (e.g. the removed Alipay). */
  METHOD_UNAVAILABLE: 'payment_method_unavailable',
  AMOUNT_TOO_SMALL: 'arbipay_amount_too_small',
  AMOUNT_TOO_LARGE: 'arbipay_amount_too_large',
} as const;
export type ArbipayThbErrorCode = (typeof ARBIPAY_THB_ERRORS)[keyof typeof ARBIPAY_THB_ERRORS];

/**
 * ARBI Pay limits apply to `input_amount` = what the buyer pays, ARBI Pay's fee included. The
 * minimum is checked on the order total (`output_amount`), which is never above `input_amount`.
 */
export const ARBIPAY_THB_MIN_AMOUNT = 20;
/**
 * PromptPay only, checked on the order total plus the PromptPay fee percent from env (an estimate
 * of ARBI Pay's real fee); ARBI Pay sets no upper limit for cards.
 */
export const ARBIPAY_PROMPTPAY_MAX_AMOUNT = 150_000;

/**
 * FRONT page behind ARBI Pay's "Return to store" button (`return_url` = the microservice client's
 * redirectDomain + this path + `?orderId=<id>`); it polls the order status.
 */
export const ARBIPAY_THB_RETURN_PATH = '/payment/return';

/**
 * Percents ARBI Pay adds on top on its payment page. The checkout shows them and the PromptPay
 * cap uses them; Lotus never charges them and never stores them in `total_price`.
 */
export const ARBIPAY_PROVIDER_FEE_ENV = {
  card: 'ARBIPAY_CARD_FEE_PERCENT',
  promptpay: 'ARBIPAY_PROMPTPAY_FEE_PERCENT',
} as const;
export const DEFAULT_ARBIPAY_PROVIDER_FEE_PERCENTS = { card: 3.6, promptpay: 2 } as const;

export type ArbipayProviderFeePercents = Record<ArbipayThbMethod, number>;
