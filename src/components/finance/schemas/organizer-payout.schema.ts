import mongoose, { Schema, Document } from 'mongoose';
import { autoIncrement } from 'mongoose-plugin-autoinc';
import {
  FINANCE_CURRENCIES,
  FinanceCurrency,
  PAYOUT_CREATOR_KINDS,
  PAYOUT_SOURCES,
  PAYOUT_STATUSES,
  PAYOUT_TYPES,
  PayoutCreatorKind,
  PayoutSource,
  PayoutStatus,
  PayoutType,
} from '../types/finance.types';

/**
 * Квитанция к выплате. `id` — это id документа Media (приватного), файл
 * отдаётся только через гвардированные маршруты финансов.
 */
export interface IOrganizerPayoutReceipt {
  id: number;
  name: string;
  mimeType: string;
  size: number;
  uploadedAt: Date;
  /** Кто загрузил (email админа / организатора). */
  uploadedBy: string;
}

/**
 * Выплата организатору по событию (spec §1.4).
 *
 * Выплаты не редактируются и не удаляются: запрос организатора (pending)
 * админ либо проводит (completed), либо отклоняет (failed); квитанции можно
 * только добавлять.
 */
export interface IOrganizerPayout extends Document {
  id: number;
  eventId: number;
  /** event.creator на момент создания. */
  organizerId: number;
  type: PayoutType;
  /** В валюте `currency`, > 0. */
  amount: number;
  currency: FinanceCurrency;
  /** THB за 1 единицу валюты; для THB = 1. */
  rateToThb: number;
  amountThb: number;
  /** null — только у запроса организатора, который ещё не проведён (pending/failed). */
  source: PayoutSource | null;
  status: PayoutStatus;
  note: string;
  requestedByOrganizer: boolean;
  receipts: IOrganizerPayoutReceipt[];
  createdByKind: PayoutCreatorKind;
  createdById: number;
  createdByLabel: string;
  resolvedAt: Date | null;
  resolvedByLabel: string | null;
  rejectReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const OrganizerPayoutReceiptSchema = new Schema<IOrganizerPayoutReceipt>(
  {
    id: { type: Number, required: true },
    name: { type: String, required: true, maxlength: 200 },
    mimeType: { type: String, required: true },
    size: { type: Number, required: true, min: 0 },
    uploadedAt: { type: Date, required: true },
    uploadedBy: { type: String, required: true },
  },
  { _id: false },
);

export const OrganizerPayoutSchema = new Schema<IOrganizerPayout>(
  {
    id: { type: Number, unique: true },
    eventId: { type: Number, required: true },
    organizerId: { type: Number, required: true },
    type: { type: String, required: true, enum: PAYOUT_TYPES },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, required: true, enum: FINANCE_CURRENCIES },
    rateToThb: { type: Number, required: true, min: 0 },
    amountThb: { type: Number, required: true },
    source: { type: String, required: false, enum: [...PAYOUT_SOURCES, null], default: null },
    status: { type: String, required: true, enum: PAYOUT_STATUSES },
    note: { type: String, required: false, default: '', maxlength: 1000 },
    requestedByOrganizer: { type: Boolean, required: true, default: false },
    receipts: { type: [OrganizerPayoutReceiptSchema], default: [] },
    createdByKind: { type: String, required: true, enum: PAYOUT_CREATOR_KINDS },
    createdById: { type: Number, required: true },
    createdByLabel: { type: String, required: true },
    resolvedAt: { type: Date, required: false, default: null },
    resolvedByLabel: { type: String, required: false, default: null },
    rejectReason: { type: String, required: false, default: null, maxlength: 500 },
  },
  { timestamps: true, collection: 'organizer_payouts' },
);

OrganizerPayoutSchema.index({ eventId: 1, createdAt: -1 });
OrganizerPayoutSchema.index({ status: 1, createdAt: -1 });

// id назначается save-хуком: создавать только через `new Model(...).save()`.
OrganizerPayoutSchema.plugin(autoIncrement, { model: 'OrganizerPayout', field: 'id', startAt: 1 });

export function organizerPayoutModel(): mongoose.Model<IOrganizerPayout> {
  return (
    (mongoose.models.OrganizerPayout as mongoose.Model<IOrganizerPayout>) ??
    mongoose.model<IOrganizerPayout>('OrganizerPayout', OrganizerPayoutSchema)
  );
}
