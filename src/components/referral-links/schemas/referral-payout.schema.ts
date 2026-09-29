import { Schema, Document, Types } from 'mongoose';

export interface IReferralPayout extends Document {
  referralLinkId: Types.ObjectId;
  paidAmount: number;
  sharesTotalAmountBefore: number;
  sharesTotalAmountAfter: number;
  sharesPaidAmountBefore: number;
  sharesPaidAmountAfter: number;
  createdAt: Date;
  updatedAt: Date;
}

export const ReferralPayoutSchema = new Schema<IReferralPayout>(
  {
    referralLinkId: {
      type: Schema.Types.ObjectId,
      ref: 'ReferralLink',
      required: true,
      index: true,
    },
    paidAmount: { type: Number, required: true },
    sharesTotalAmountBefore: { type: Number, required: true },
    sharesTotalAmountAfter: { type: Number, required: true },
    sharesPaidAmountBefore: { type: Number, required: true },
    sharesPaidAmountAfter: { type: Number, required: true },
  },
  { timestamps: true },
);

ReferralPayoutSchema.index({ referralLinkId: 1, createdAt: -1 });
