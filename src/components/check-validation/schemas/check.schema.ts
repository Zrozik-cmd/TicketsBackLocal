import { Schema, Document } from 'mongoose';
import { autoIncrement } from 'mongoose-plugin-autoinc';

export type CheckValidationStatus = 'approved' | 'rejected';

export interface ICheckValidation extends Document {
  id: number;
  orderId: number;
  customerId: number;
  bank: string;
  date: string;
  amount: number;
  transactionId: string;
  refNo: string;
  to: string;
  file: Buffer;
  mimeType: string;
  status: CheckValidationStatus;
  failReason?: string;
  gptModel: string;
  rawResponse?: string;
  createdAt: Date;
  updatedAt: Date;
}

export const CheckValidationSchema = new Schema<ICheckValidation>(
  {
    id: { type: Number, unique: true },
    orderId: { type: Number, required: true, index: true },
    customerId: { type: Number, required: true, index: true },
    bank: { type: String, required: true, default: '' },
    date: { type: String, required: true, default: '' },
    amount: { type: Number, required: true, default: 0 },
    transactionId: { type: String, required: false, default: '' },
    refNo: { type: String, required: false, default: '' },
    to: { type: String, required: true, default: '' },
    file: { type: Buffer, required: true },
    mimeType: { type: String, required: true },
    status: { type: String, enum: ['approved', 'rejected'], required: true },
    failReason: { type: String, required: false },
    gptModel: { type: String, required: true },
    rawResponse: { type: String, required: false },
  },
  { timestamps: true },
);

CheckValidationSchema.plugin(autoIncrement, {
  model: 'CheckValidation',
  field: 'id',
  startAt: 1,
});

// Prevent duplicate non-empty ref_no across all checks.
CheckValidationSchema.index(
  { refNo: 1 },
  {
    unique: true,
    partialFilterExpression: {
      refNo: { $exists: true, $gt: '' },
      status: 'approved',
    },
  },
);

