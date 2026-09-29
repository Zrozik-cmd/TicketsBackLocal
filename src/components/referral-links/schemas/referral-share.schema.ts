import { Schema, Document, Types } from 'mongoose';

export interface IReferralShare extends Document {
  referralLinkId: Types.ObjectId;
  /** MockOrder document _id */
  orderId: Types.ObjectId;
  orderPrice: number;
  orderTotalPrice: number;
  shareAmount: number;
  createdAt: Date;
  updatedAt: Date;
}

export const ReferralShareSchema = new Schema<IReferralShare>(
  {
    referralLinkId: {
      type: Schema.Types.ObjectId,
      ref: 'ReferralLink',
      required: true,
      index: true,
    },
    orderId: {
      type: Schema.Types.ObjectId,
      ref: 'MockOrder',
      required: true,
      unique: true,
      index: true,
    },
    orderPrice: { type: Number, required: true },
    orderTotalPrice: { type: Number, required: true },
    shareAmount: { type: Number, required: true },
  },
  { timestamps: true },
);

ReferralShareSchema.index({ referralLinkId: 1, createdAt: -1 });
