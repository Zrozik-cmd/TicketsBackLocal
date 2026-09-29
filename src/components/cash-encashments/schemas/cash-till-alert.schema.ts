import { Schema, Document } from 'mongoose';

/**
 * Ватерлиния уведомлений о кассе. Храним НЕ факт «письмо отправлено», а
 * достигнутый уровень: касса растёт и падает, поэтому уровень опускается
 * вместе с ней — после инкассации переход через тот же порог сработает снова.
 *
 * Плагин autoinc сознательно не подключён: документ создаётся через upsert,
 * а save-хук автоинкремента при upsert не выполняется.
 */
export interface ICashTillAlert extends Document {
  /** Владелец кассы; 0 — общая касса админки. */
  cashierId: number;
  /** Снимок для писем и разбора, ключом не является. */
  cashierEmail: string;
  /** Сколько полных порогов уже подтверждено уведомлением. */
  lastNotifiedStep: number;
  /** Касса на момент последнего письма — для текста и разбора. */
  lastNotifiedTill: number;
  lastNotifiedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export const CashTillAlertSchema = new Schema<ICashTillAlert>(
  {
    cashierId: { type: Number, required: true, unique: true },
    cashierEmail: { type: String, required: false, trim: true, lowercase: true, default: '' },
    lastNotifiedStep: { type: Number, required: true, default: 0 },
    lastNotifiedTill: { type: Number, required: true, default: 0 },
    lastNotifiedAt: { type: Date, required: false },
  },
  { timestamps: true, collection: 'cash_till_alerts' },
);
