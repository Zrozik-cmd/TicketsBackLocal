import { ReferralLinkStatus } from '../schemas/referral-link.schema';

export class ReferralLinkStatsResponseDto {
  follows: number;
  registrations: number;
  totalSalesCount: number;
  totalSalesAmount: number;
  totalSalesAmountWithVat: number;
  conversionRate: number;
  sharesTotalAmount: number;
  sharesPaidAmount: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Single referral link with aggregates — GET /referral-links/:id.
 */
export class ReferralLinkDetailResponseDto {
  id: string;
  internalName: string;
  source: string;
  referralCode: string;
  partnerCabinetPin: string;
  status: ReferralLinkStatus;
  hasReward: boolean;
  rewardPercent: number;
  createdAt: Date;
  updatedAt: Date;
  stats: ReferralLinkStatsResponseDto;
}

