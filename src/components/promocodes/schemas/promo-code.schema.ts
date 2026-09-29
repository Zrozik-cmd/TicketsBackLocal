import { Schema, Document } from 'mongoose';

export type DiscountType = 'percentage' | 'fixed';

export const DISCOUNT_TYPES: DiscountType[] = ['percentage', 'fixed'];

export interface IPromoCode extends Document {
  /** Organizer user id (JWT `sub`), same scoping as referral links. */
  userId: number;
  internalName: string;
  assignedTo?: string;
  promoCode: string;
  discountType: DiscountType;
  discountValue: number;
  expirationDate: Date;
  /** Max tickets one customer may buy with this promo (per customer; enforced via CustomerPromoCodeUsage). */
  maxTicketsCountByCustomer: number;
  /** Max tickets that can be bought with this promo across all customers. */
  maxTicketsCountTotal: number;
  /** Tickets already purchased with this promo (all customers). */
  currentTicketsCountTotal: number;
  applyToAllEvents: boolean;
  applicableEventIds?: string[];
  createdAt: Date;
  updatedAt: Date;
}

export const PromoCodeSchema = new Schema<IPromoCode>(
  {
    userId: { type: Number, required: true, index: true },
    internalName: { type: String, required: true, trim: true },
    assignedTo: { type: String, trim: true },
    promoCode: { type: String, required: true, trim: true },
    discountType: {
      type: String,
      enum: DISCOUNT_TYPES,
      required: true,
    },
    discountValue: { type: Number, required: true },
    expirationDate: { type: Date, required: true },
    maxTicketsCountByCustomer: { type: Number, required: true, min: 1 },
    maxTicketsCountTotal: { type: Number, required: true, min: 1 },
    currentTicketsCountTotal: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    applyToAllEvents: { type: Boolean, required: true },
    applicableEventIds: [{ type: String }],
  },
  { timestamps: true },
);

PromoCodeSchema.index({ promoCode: 1 }, { unique: true });
