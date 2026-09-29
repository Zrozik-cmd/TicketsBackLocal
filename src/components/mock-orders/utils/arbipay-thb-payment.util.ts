/**
 * Card / PromptPay (THB) checkout through ARBI Pay: which checkouts go there, ARBI Pay's amount
 * limits, the `createTransaction` request and the display-only fee percents. Pure (no Nest, no
 * I/O) so the rules can be exercised from a plain script.
 */
import {
  ARBIPAY_PAYMENT_METHOD,
  toMinorUnits,
} from '../constants/payment-currency.constant';
import {
  ARBIPAY_PROMPTPAY_MAX_AMOUNT,
  ARBIPAY_PROVIDER_FEE_ENV,
  ARBIPAY_THB_ERRORS,
  ARBIPAY_THB_METHODS,
  ARBIPAY_THB_MIN_AMOUNT,
  ARBIPAY_THB_RETURN_PATH,
  DEFAULT_ARBIPAY_PROVIDER_FEE_PERCENTS,
  type ArbipayProviderFeePercents,
  type ArbipayThbErrorCode,
  type ArbipayThbMethod,
} from '../constants/arbipay-thb.constant';
import type { MockOrderPaymentMethod } from '../schemas/mock-order.schema';
import { roundMoney } from './mock-order-refund.util';
import type { PaymentMicroserviceService } from '../payment/payment-microservice.service';

export interface ArbipayThbPlan {
  method: ArbipayThbMethod;
  /** ARBI Pay `payment_method`: 5 card, 6 PromptPay. */
  arbiPaymentMethod: number;
  /** Stored on the order: statistics, refunds and sale labels bucket THB orders by it. */
  orderPaymentMethod: Extract<MockOrderPaymentMethod, 'CARD' | 'QR'>;
}

export const ARBIPAY_THB_PLANS: Readonly<Record<ArbipayThbMethod, ArbipayThbPlan>> = {
  card: { method: 'card', arbiPaymentMethod: ARBIPAY_PAYMENT_METHOD.CARD_THB, orderPaymentMethod: 'CARD' },
  promptpay: {
    method: 'promptpay',
    arbiPaymentMethod: ARBIPAY_PAYMENT_METHOD.PROMPTPAY_THB,
    orderPaymentMethod: 'QR',
  },
};

/** `paymentMethod` values of THB orders paid on ARBI Pay (also old direct-Omise card / QR orders). */
export const ARBIPAY_THB_ORDER_PAYMENT_METHODS: MockOrderPaymentMethod[] = ARBIPAY_THB_METHODS.map(
  (method) => ARBIPAY_THB_PLANS[method].orderPaymentMethod,
);

export type ArbipayThbCheck =
  | { plan: ArbipayThbPlan; error: null }
  | { plan: null; error: ArbipayThbErrorCode | null };

/**
 * Decides, before the order is written, whether a checkout is paid on ARBI Pay by card /
 * PromptPay. `{ plan: null, error: null }` = another flow (RUB / USDT / KZT, or THB without a
 * method = the legacy manual receipt flow), which this must leave untouched.
 * `providerFeePercents`: ARBI Pay caps PromptPay's fee-inclusive amount, not the order total.
 */
export function checkArbipayThbCheckout(
  paymentCurrency: string,
  method: string | undefined,
  totalPrice: number,
  providerFeePercents: ArbipayProviderFeePercents,
): ArbipayThbCheck {
  if (paymentCurrency !== 'THB' || method == null) return { plan: null, error: null };
  if (!(ARBIPAY_THB_METHODS as readonly string[]).includes(method)) {
    return { plan: null, error: ARBIPAY_THB_ERRORS.METHOD_UNAVAILABLE };
  }
  const plan = ARBIPAY_THB_PLANS[method as ArbipayThbMethod];
  // ARBI Pay's limits apply to input_amount = the order total plus its fee on top (what the
  // buyer pays); the FRONT checks the same fee-inclusive amount (purchase-section/arbipay-thb.ts).
  const buyerPays = roundMoney(totalPrice * (1 + providerFeePercents[plan.method] / 100));
  if (buyerPays < ARBIPAY_THB_MIN_AMOUNT) {
    return { plan: null, error: ARBIPAY_THB_ERRORS.AMOUNT_TOO_SMALL };
  }
  if (plan.method === 'promptpay' && buyerPays > ARBIPAY_PROMPTPAY_MAX_AMOUNT) {
    return { plan: null, error: ARBIPAY_THB_ERRORS.AMOUNT_TOO_LARGE };
  }
  return { plan, error: null };
}

/**
 * Microservice request: Lotus asks ARBI Pay to collect the order total in THB (`output_amount`);
 * ARBI Pay adds its own fee on top and the buyer pays that on ARBI Pay's page. Its "Return to
 * store" button leads to the per-order FRONT return page (not the env PAYMENT_REDIRECT_PATH).
 * `storeCode` routes the payment into the event's own store, like SBP / USDT payments.
 */
export function buildArbipayThbTransaction(
  orderId: number,
  plan: ArbipayThbPlan,
  totalPrice: number,
  storeCode: string | null = null,
): Parameters<PaymentMicroserviceService['createTransaction']>[0] {
  return {
    orderId,
    amountInMinorUnits: toMinorUnits(totalPrice),
    currency: 'THB',
    outputCurrency: 'THB',
    paymentMethod: plan.arbiPaymentMethod,
    description: `Lotus Arena order #${orderId} (${plan.method})`,
    redirectPath: `${ARBIPAY_THB_RETURN_PATH}?orderId=${orderId}`,
    // The event's own ARBI Pay store (arbipay-stores); `null` → the client's common store.
    storeCode,
  };
}

/** ARBI Pay fee percents from env (checkout display, PromptPay cap); blank / negative / non-numeric → default. */
export function resolveArbipayProviderFeePercents(
  readEnv: (key: string) => string | undefined,
): ArbipayProviderFeePercents {
  return {
    card: parseFeePercent(readEnv(ARBIPAY_PROVIDER_FEE_ENV.card), DEFAULT_ARBIPAY_PROVIDER_FEE_PERCENTS.card),
    promptpay: parseFeePercent(
      readEnv(ARBIPAY_PROVIDER_FEE_ENV.promptpay),
      DEFAULT_ARBIPAY_PROVIDER_FEE_PERCENTS.promptpay,
    ),
  };
}

function parseFeePercent(raw: string | undefined, fallback: number): number {
  const value = String(raw ?? '').trim();
  const percent = Number(value);
  return value !== '' && Number.isFinite(percent) && percent >= 0 ? percent : fallback;
}
