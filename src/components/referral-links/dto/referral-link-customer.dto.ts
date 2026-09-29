export type ReferralLinkCustomerStatus = 'registered' | 'purchased';

/** Customer registered via a referral link (organizer-facing). */
export class ReferralLinkCustomerDto {
  id: number;
  name: string;
  email: string;
  dateOfRegistration: Date;
  status: ReferralLinkCustomerStatus;
  numberOfOrders: number;
}

export class ReferralLinkCustomersPageDto {
  items: ReferralLinkCustomerDto[];
  total: number;
  page: number;
  limit: number;
}
