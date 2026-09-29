import { Schema, Document, Types } from 'mongoose';

export interface IReferralLinkStats extends Document {
  referralLinkId: Types.ObjectId;
  follows: number;
  registrations: number;
  totalSalesCount: number;
  totalSalesAmount: number;
  totalSalesAmountWithVat: number;
  sharesTotalAmount: number;
  sharesPaidAmount: number;
  conversionRate: number;
  createdAt: Date;
  updatedAt: Date;
}

export const ReferralLinkStatsSchema = new Schema<IReferralLinkStats>(
  {
    referralLinkId: {
      type: Schema.Types.ObjectId,
      ref: 'ReferralLink',
      required: true,
      unique: true,
      index: true,
    },
    follows: { type: Number, required: true, default: 0 },
    registrations: { type: Number, required: true, default: 0 },
    totalSalesCount: { type: Number, required: true, default: 0 },
    totalSalesAmount: { type: Number, required: true, default: 0 },
    totalSalesAmountWithVat: { type: Number, required: true, default: 0 },
    sharesTotalAmount: { type: Number, required: true, default: 0 },
    sharesPaidAmount: { type: Number, required: true, default: 0 },
    conversionRate: { type: Number, required: true, default: 0 },
  },
  { timestamps: true },
);
