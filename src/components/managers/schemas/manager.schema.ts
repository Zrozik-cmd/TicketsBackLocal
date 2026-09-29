import { Schema, Document } from 'mongoose';
import { autoIncrement } from 'mongoose-plugin-autoinc';
import { MANAGER_TYPES, ManagerType } from '../manager-type';

export interface IManager extends Document {
  id: number;
  title: string;
  type: ManagerType;
  allEvents?: boolean;
  events?: number[];
  event?: number;
  email?: string;
  cashierName?: string;
  cashierPin?: string;
  description?: string;
  /** User.id of the organizer who created this manager (JWT / API user). */
  createdByUserId: number;
  createdAt: Date;
  updatedAt: Date;
}

export const ManagerSchema = new Schema<IManager>(
  {
    id: { type: Number, unique: true },
    title: { type: String, required: true, trim: true },
    type: { type: String, required: true, trim: true, enum: [...MANAGER_TYPES] },
    allEvents: { type: Boolean, required: false, default: false },
    events: { type: [Number], required: false, index: true },
    event: { type: Number, required: false, index: true },
    email: { type: String, required: false, trim: true, lowercase: true, default: '' },
    cashierName: { type: String, required: false, trim: true, default: '' },
    cashierPin: { type: String, required: false, trim: true, default: '' },
    description: { type: String, required: false, trim: true, default: '' },
    createdByUserId: { type: Number, required: true, ref: 'User', index: true },
  },
  { timestamps: true },
);

ManagerSchema.plugin(autoIncrement, { model: 'Manager', field: 'id', startAt: 1 });

ManagerSchema.index(
  { email: 1 },
  {
    unique: true,
    partialFilterExpression: { email: { $exists: true, $gt: '' } },
  },
);

ManagerSchema.index(
  { cashierPin: 1 },
  {
    unique: true,
    partialFilterExpression: {
      cashierPin: { $exists: true, $gt: '' },
      type: 'Cashier',
    },
  },
);
