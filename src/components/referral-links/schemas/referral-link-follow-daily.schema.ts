import { Schema, Document, Types } from 'mongoose';

export interface IReferralLinkFollowDaily extends Document {
  referralLinkId: Types.ObjectId;
  /** UTC calendar date, YYYY-MM-DD */
  dayKey: string;
  follows: number;
  createdAt: Date;
  updatedAt: Date;
}

export const ReferralLinkFollowDailySchema = new Schema<IReferralLinkFollowDaily>(
  {
    referralLinkId: {
      type: Schema.Types.ObjectId,
      ref: 'ReferralLink',
      required: true,
      index: true,
    },
    dayKey: { type: String, required: true },
    follows: { type: Number, required: true, default: 0 },
  },
  { timestamps: true },
);

ReferralLinkFollowDailySchema.index(
  { referralLinkId: 1, dayKey: 1 },
  { unique: true },
);
