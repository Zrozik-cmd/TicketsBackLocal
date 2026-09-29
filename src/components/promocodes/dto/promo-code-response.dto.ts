import { DiscountType } from '../schemas/promo-code.schema';

export class PromoCodeResponseDto {
  id: string;
  internalName: string;
  assignedTo?: string;
  promoCode: string;
  discountType: DiscountType;
  discountValue: number;
  expirationDate: Date;
  maxTicketsCountByCustomer: number;
  maxTicketsCountTotal: number;
  currentTicketsCountTotal: number;
  applyToAllEvents: boolean;
  applicableEventIds?: string[];
  createdAt: Date;
  updatedAt: Date;
}
