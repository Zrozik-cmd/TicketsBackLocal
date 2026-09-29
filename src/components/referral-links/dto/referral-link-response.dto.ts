import { ReferralLinkStatus } from '../schemas/referral-link.schema';

/**
 * Single referral link as returned by GET /referral-links (list item).
 */
export class ReferralLinkResponseDto {
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
}
