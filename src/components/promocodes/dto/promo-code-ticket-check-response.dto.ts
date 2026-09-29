import { DiscountType } from '../schemas/promo-code.schema';

/** Public payload for checkout UI (price preview); does not consume the promo. */
export class PromoCodeTicketCheckResponseDto {
  promoCode: string;
  discountType: DiscountType;
  discountValue: number;
  expirationDate: string;
  maxTicketsCountByCustomer: number;
  maxTicketsCountTotal: number;
  currentTicketsCountTotal: number;
  /** This customer's tickets already purchased with this promo. */
  customerTicketsPurchased: number;
  /** Effective tickets still allowed for this request (min of per-customer and global remaining). */
  remainingTickets: number;
  eventId: number;
  /** MongoDB id of the promo document (for order persistence / usage after payment). */
  promoCodeId: string;
}
