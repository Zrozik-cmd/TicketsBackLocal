export type PromoCodeStatisticsDiscountType = 'PERCENT' | 'FIXED';

export type PromoCodeStatisticsStatus = 'ACTIVE' | 'EXPIRED';

/** Payload for GET /promocodes/statistics (organizer-facing). */
export class PromoCodeStatisticsDto {
  code: string;
  internalLabel: string;
  discountType: PromoCodeStatisticsDiscountType;
  value: number;
  usageCount: number;
  /** Global cap (`maxTicketsCountTotal`). */
  maxTicketsCountTotal: number;
  /** Per-customer cap (`maxTicketsCountByCustomer`). */
  maxTicketsCountByCustomer: number;
  expiresAt: string;
  status: PromoCodeStatisticsStatus;
}
