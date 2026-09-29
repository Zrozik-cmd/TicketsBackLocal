export class ReferralPayoutResponseDto {
  id: string;
  referralLinkId: string;
  paidAmount: number;
  sharesTotalAmountBefore: number;
  sharesTotalAmountAfter: number;
  sharesPaidAmountBefore: number;
  sharesPaidAmountAfter: number;
  createdAt: Date;
  updatedAt: Date;
}

export class ReferralPayoutsPageDto {
  items: ReferralPayoutResponseDto[];
  total: number;
  page: number;
  limit: number;
}
