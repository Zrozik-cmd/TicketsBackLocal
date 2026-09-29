/**
 * When an unpaid online order (`wait`) gives its seats back. Pure: `now` is passed in.
 */
import type { FilterQuery } from 'mongoose';
import type { IMockOrder } from '../schemas/mock-order.schema';
import { ARBIPAY_THB_ORDER_PAYMENT_METHODS } from './arbipay-thb-payment.util';

/**
 * Orders paid through ARBI Pay: SBP (RUB), USDT, KZT and card / PromptPay (THB). ARBI Pay keeps an
 * unpaid payment open for about 30 min (docs: card and PromptPay 30 min, other methods «около 30
 * минут» bank timeout), so the order waits a bit longer and a late payment still finds it in `wait`.
 */
export const ARBIPAY_PENDING_ORDER_TTL_MS = 35 * 60 * 1000;
/** The legacy THB transfer confirmed by a receipt (THB without a card / PromptPay method). */
export const PENDING_ORDER_TTL_MS = 15 * 60 * 1000;

/** `wait` orders whose payment window is over at `now` (ms). No other status is matched. */
export function buildExpiredPendingOrdersFilter(now: number): FilterQuery<IMockOrder> {
  // Every currency except THB goes through ARBI Pay; THB only with a card / PromptPay method.
  const legacyThbTransfer: FilterQuery<IMockOrder> = {
    paymentCurrency: { $in: ['THB', null] },
    paymentMethod: { $nin: ARBIPAY_THB_ORDER_PAYMENT_METHODS },
  };
  return {
    status: 'wait',
    $or: [
      { createdAt: { $lt: new Date(now - ARBIPAY_PENDING_ORDER_TTL_MS) } },
      { createdAt: { $lt: new Date(now - PENDING_ORDER_TTL_MS) }, ...legacyThbTransfer },
    ],
  };
}
