import { Schema, Document } from 'mongoose';
import { autoIncrement } from 'mongoose-plugin-autoinc';

/**
 * Журнал движений наличных. Касса — это СУММА подписанных записей владельца,
 * а не разница «заработано минус сдано»: каждое событие с деньгами оставляет
 * свою строку, записи не редактируются и не удаляются — ошибки исправляются
 * корректировкой с примечанием.
 *
 * Владелец — неизменяемый cashierId (0 — общая касса админки); email хранится
 * только снимком для отображения, смена email кассира ни на что не влияет.
 */
export const CASH_LEDGER_TYPES = [
  'sale', //        + подтверждённый заказ наличными
  'encashment', //  − сдача инкассатору
  'refund', //      − возврат по заказу
  'opening', //     ± исторический остаток на момент внедрения журнала
  'adjustment', //  ± ручная корректировка админа (с примечанием)
  'reset', //       ± обнуление кассы админом (с обязательной причиной)
] as const;
export type CashLedgerType = (typeof CASH_LEDGER_TYPES)[number];

export const CASH_LEDGER_ACTOR_ROLES = ['Admin', 'CashierArbi', 'system'] as const;
export type CashLedgerActorRole = (typeof CASH_LEDGER_ACTOR_ROLES)[number];

export interface ICashLedgerEntry extends Document {
  id: number;
  /** 0 — общая касса админки. */
  cashierId: number;
  /** Снимок на момент записи; НЕ ключ. */
  cashierEmail: string;
  type: CashLedgerType;
  /** Подписанная сумма: продажи +, инкассации и возвраты −. */
  amount: number;
  currency: string;
  /** sale/refund: заказ-источник. */
  orderId?: number;
  /** encashment: кому переданы деньги. */
  collectorName?: string;
  /** adjustment/opening/reset: причина. */
  note?: string;
  /*
   * Кто именно сделал движение — журнал действий. Для админских операций это
   * НЕ обезличенное 'admin', а конкретный аккаунт: обнуление чужой кассы
   * должно иметь автора, иначе спрашивать не с кого.
   */
  createdBy?: string;
  createdById?: number;
  createdByRole?: CashLedgerActorRole;
  createdAt: Date;
  updatedAt: Date;
}

export const CashLedgerEntrySchema = new Schema<ICashLedgerEntry>(
  {
    id: { type: Number, unique: true },
    cashierId: { type: Number, required: true },
    cashierEmail: { type: String, required: true, trim: true, lowercase: true },
    type: { type: String, required: true, enum: CASH_LEDGER_TYPES },
    amount: { type: Number, required: true },
    currency: { type: String, required: true, default: 'THB' },
    orderId: { type: Number, required: false },
    collectorName: { type: String, required: false, trim: true },
    note: { type: String, required: false, trim: true },
    createdBy: { type: String, required: false, trim: true },
    createdById: { type: Number, required: false },
    createdByRole: { type: String, required: false, enum: CASH_LEDGER_ACTOR_ROLES },
  },
  { timestamps: true },
);

CashLedgerEntrySchema.index({ cashierId: 1, createdAt: -1 });
CashLedgerEntrySchema.index({ cashierId: 1, type: 1, createdAt: -1 });
/** Одна sale-строка на заказ: повторная финализация не задваивает кассу. */
CashLedgerEntrySchema.index(
  { orderId: 1, type: 1 },
  { unique: true, partialFilterExpression: { type: 'sale' } },
);

CashLedgerEntrySchema.plugin(autoIncrement, { model: 'CashLedgerEntry', field: 'id', startAt: 1 });
