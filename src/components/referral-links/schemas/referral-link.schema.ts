import { Schema, Document } from 'mongoose';

export type ReferralLinkStatus = 'active' | 'inactive';

export interface IReferralLink extends Document {
  /** Matches `User.id` (numeric), from JWT `sub`. */
  userId: number;

  internalName: string;
  source: string;
  referralCode: string;
  partnerCabinetPin: string;
  status: ReferralLinkStatus;
  hasReward: boolean;
  rewardPercent: number;
  createdAt: Date;
  updatedAt: Date;
}

export const ReferralLinkSchema = new Schema<IReferralLink>(
  {
    userId: { type: Number, required: true, index: true },
    internalName: { type: String, required: true, trim: true },
    source: { type: String, required: true },
    referralCode: { type: String, required: true },
    partnerCabinetPin: { type: String, required: true },
    status: {
      type: String,
      enum: ['active', 'inactive'],
      required: true,
      default: 'active',
    },
    hasReward: { type: Boolean, required: true, default: false },
    rewardPercent: { type: Number, required: true, default: 0 },
  },
  { timestamps: true },
);

ReferralLinkSchema.index({ referralCode: 1 }, { unique: true });
ReferralLinkSchema.index({ internalName: 1 }, { unique: true });
