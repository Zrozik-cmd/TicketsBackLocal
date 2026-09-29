import type { MockOrderPaymentCurrency } from '../schemas/mock-order.schema';
import type { CreateOrderPaymentPayload } from '../payment/payment-microservice.types';

/**
 * `originalPaidAmount` at checkout: what the buyer pays in the payment currency. THB orders pay
 * their `total_price`; an ARBI Pay payment in RUB / USDT / KZT reports it as `input_amount`
 * (ARBI Pay's fee on top of the order total included). Unknown yet → `undefined` (the webhook
 * fills it on confirm). Pure, moved out of MockOrdersService.
 */
export function resolveOriginalPaidAmount(
  paymentCurrency: MockOrderPaymentCurrency,
  totalPrice: number,
  payment: CreateOrderPaymentPayload | null,
): number | undefined {
  if (paymentCurrency === 'THB') {
    return totalPrice;
  }
  const arbiPayload = payment?.providerMetadata?.arbiPayload;
  if (arbiPayload && typeof arbiPayload === 'object') {
    const inputAmount = (arbiPayload as { input_amount?: unknown }).input_amount;
    if (typeof inputAmount === 'number' && Number.isFinite(inputAmount)) {
      return inputAmount;
    }
  }
  return undefined;
}
