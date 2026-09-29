import mongoose, { Schema, Document } from 'mongoose';
import { autoIncrement } from 'mongoose-plugin-autoinc';

/**
 * Подтверждение, что инкассация дошла до сейфа офиса (spec §1.5).
 *
 * Журнал касс не меняется: инкассация без квитанции — «в пути», с квитанцией —
 * «в сейфе». Одна квитанция на строку журнала (уникальный ledgerEntryId), поэтому
 * повторное подтверждение ничего не задваивает.
 */
export interface ICashVaultReceipt extends Document {
  id: number;
  /** id строки CashLedgerEntry типа 'encashment'. */
  ledgerEntryId: number;
  /** Положительная сумма, = −amount строки журнала. */
  amount: number;
  receivedAt: Date;
  receivedByAdminId: number;
  receivedByLabel: string;
  note: string;
  createdAt: Date;
  updatedAt: Date;
}

export const CashVaultReceiptSchema = new Schema<ICashVaultReceipt>(
  {
    id: { type: Number, unique: true },
    ledgerEntryId: { type: Number, required: true, unique: true },
    amount: { type: Number, required: true, min: 0 },
    receivedAt: { type: Date, required: true },
    receivedByAdminId: { type: Number, required: true },
    receivedByLabel: { type: String, required: true },
    note: { type: String, required: false, default: '', maxlength: 500 },
  },
  { timestamps: true, collection: 'cash_vault_receipts' },
);

// id назначается save-хуком: создавать только через `new Model(...).save()`.
CashVaultReceiptSchema.plugin(autoIncrement, { model: 'CashVaultReceipt', field: 'id', startAt: 1 });

export function cashVaultReceiptModel(): mongoose.Model<ICashVaultReceipt> {
  return (
    (mongoose.models.CashVaultReceipt as mongoose.Model<ICashVaultReceipt>) ??
    mongoose.model<ICashVaultReceipt>('CashVaultReceipt', CashVaultReceiptSchema)
  );
}
