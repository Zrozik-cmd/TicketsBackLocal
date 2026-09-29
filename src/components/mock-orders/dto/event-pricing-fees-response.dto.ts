import type { ArbipayProviderFeePercents } from '../constants/arbipay-thb.constant';

/**
 * GET /mock-orders/events/:eventId/pricing-fees
 *
 * Percents match server order pricing (promo-adjusted subtotal as base).
 * Rates are decimals for multiplication: subtotal * vatRate, subtotal * additionalTicketCostFeeRate.
 */
export interface EventPricingFeesResponseDto {
  eventId: number;
  vatPercent: number;
  additionalTicketCostFeePercent: number;
  /** Always 0: Lotus no longer adds a card surcharge (field kept for older checkout builds). */
  bankCardFeePercent: number;
  /** Service commission percent for cash payments, same basis as the card surcharge. */
  cashFeePercent: number;
  vatRate: number;
  additionalTicketCostFeeRate: number;
  bankCardFeeRate: number;
  cashFeeRate: number;
  /**
   * Display-only: percent ARBI Pay adds on top on its own page for card / PromptPay (THB).
   * Lotus never charges it and never adds it to `total_price`.
   */
  providerFeePercents: ArbipayProviderFeePercents;
}
