import { Schema, Document, Types } from 'mongoose';

/** Tracks how many tickets a customer has purchased with a given promo code (per-customer cap vs maxTicketsCountByCustomer). */
export interface ICustomerPromoCodeUsage extends Document {
  customerId: number;
  promoCodeId: Types.ObjectId;
  /** Tickets this customer has already bought using this promo (paid orders). */
  ticketsPurchased: number;
  createdAt: Date;
  updatedAt: Date;
}

export const CustomerPromoCodeUsageSchema = new Schema<ICustomerPromoCodeUsage>(
  {
    customerId: { type: Number, required: true, index: true },
    promoCodeId: {
      type: Schema.Types.ObjectId,
      ref: 'PromoCode',
      required: true,
    },
    ticketsPurchased: { type: Number, required: true, default: 0, min: 0 },
  },
  { timestamps: true },
);

CustomerPromoCodeUsageSchema.index(
  { customerId: 1, promoCodeId: 1 },
  { unique: true },
);
