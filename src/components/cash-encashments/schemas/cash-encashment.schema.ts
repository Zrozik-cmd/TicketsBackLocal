import { Schema, Document } from 'mongoose';
import { autoIncrement } from 'mongoose-plugin-autoinc';

/**
 * Одна сдача наличных инкассатору. Касса кассира считается как
 * (все подтверждённые им CASH-заказы за всё время) − (сумма его инкассаций),
 * поэтому записи никогда не редактируются и не удаляются.
 */
export interface ICashEncashment extends Document {
  id: number;
  cashierId: number;
  /** Совпадает с mock-order.cashierEmail — по нему считается статистика. */
  cashierEmail: string;
  collectorName: string;
  amount: number;
  currency: string;
  /** Проставляется после переноса строки в журнал движений; коллекция — архив. */
  migratedToLedgerAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export const CashEncashmentSchema = new Schema<ICashEncashment>(
  {
    id: { type: Number, unique: true },
    cashierId: { type: Number, required: true },
    cashierEmail: { type: String, required: true, trim: true, lowercase: true },
    collectorName: { type: String, required: true, trim: true },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, required: true, default: 'THB' },
    migratedToLedgerAt: { type: Date, required: false },
  },
  { timestamps: true },
);

CashEncashmentSchema.index({ cashierEmail: 1, createdAt: -1 });

CashEncashmentSchema.plugin(autoIncrement, { model: 'CashEncashment', field: 'id', startAt: 1 });
