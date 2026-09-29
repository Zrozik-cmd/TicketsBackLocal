import type { DiscountType } from '../../promocodes/schemas/promo-code.schema';
import { roundMoney } from './mock-order-refund.util';

/**
 * Цена билетов после промокода (до НДС и сборов): процент или фиксированная сумма, не
 * больше самой цены и не ниже нуля. Одно правило на обе кассы — онлайн и наличные.
 */
export function applyPromoDiscount(basePrice: number, discountType: DiscountType, discountValue: number): number {
  if (basePrice <= 0) return 0;
  const discountAmount = discountType === 'percentage' ? (basePrice * discountValue) / 100 : discountValue;
  const appliedDiscount = Math.min(discountAmount, basePrice);
  return Math.max(0, roundMoney(basePrice - appliedDiscount));
}
