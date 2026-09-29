import { Schema, Document, Types } from 'mongoose';
import { autoIncrement } from 'mongoose-plugin-autoinc';

export interface ICustomer extends Document {
  id: number;
  fullname: string;
  email: string;
  phone?: string;
  referralLink?: Types.ObjectId;
  lastActivity?: Date;
  /** Email-marketing consent (checkout checkbox); kept locally as GDPR/PDPA proof, Mailchimp holds the live list. */
  emailMarketingConsent?: boolean;
  emailMarketingConsentAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export const CustomerSchema = new Schema<ICustomer>(
  {
    id: { type: Number, unique: true },
    fullname: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    phone: { type: String, required: false, default: '', trim: true },
    referralLink: {
      type: Schema.Types.ObjectId,
      ref: 'ReferralLink',
      required: false,
    },
    lastActivity: { type: Date, required: false },
    emailMarketingConsent: { type: Boolean, required: false },
    emailMarketingConsentAt: { type: Date, required: false },
  },
  { timestamps: true },
);

CustomerSchema.plugin(autoIncrement, { model: 'Customer', field: 'id', startAt: 1 });
