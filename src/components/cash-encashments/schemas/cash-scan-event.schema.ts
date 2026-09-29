import { Schema, Document } from 'mongoose';
import { autoIncrement } from 'mongoose-plugin-autoinc';
import { ILocalizedText } from '../../events/schemas/event.schema';

/** Снимок названия события; свой, а не общий — в журнале хранится копия, не ссылка. */
const ScanEventTitleSchema = new Schema<ILocalizedText>(
  {
    th: { type: String, required: false },
    en: { type: String, required: false },
    ru: { type: String, required: false },
  },
  { _id: false },
);

export const CASH_SCAN_SOURCES = ['scan', 'manual'] as const;
export type CashScanSource = (typeof CASH_SCAN_SOURCES)[number];

/**
 * Журнал проверок броней на кассе: каждый скан QR и каждый ручной ввод кода,
 * включая ненайденные. Отвечает на вопрос «что кассир держал в руках», даже
 * если оплата в итоге не прошла, поэтому пишется до всякого подтверждения.
 *
 * Данные заказа сохраняются снимком на момент проверки: событие могут
 * переименовать, а в журнале должно остаться то, что видел кассир.
 */
export interface ICashScanEvent extends Document {
  id: number;
  /** 0 — проверка из админки. */
  cashierId: number;
  cashierEmail: string;
  /** Что именно ввели/отсканировали. */
  code: string;
  source: CashScanSource;
  found: boolean;
  orderId?: number;
  bookingCode?: string;
  eventId?: number;
  eventTitle?: ILocalizedText;
  ticketsCount?: number;
  amount?: number;
  currency?: string;
  /** Статус брони в момент проверки. */
  orderStatus?: string;
  createdAt: Date;
  updatedAt: Date;
}

export const CashScanEventSchema = new Schema<ICashScanEvent>(
  {
    id: { type: Number, unique: true },
    cashierId: { type: Number, required: true },
    cashierEmail: { type: String, required: true, trim: true, lowercase: true },
    code: { type: String, required: true, trim: true },
    source: { type: String, required: true, enum: CASH_SCAN_SOURCES, default: 'scan' },
    found: { type: Boolean, required: true },
    orderId: { type: Number, required: false },
    bookingCode: { type: String, required: false, trim: true },
    eventId: { type: Number, required: false },
    eventTitle: { type: ScanEventTitleSchema, required: false },
    ticketsCount: { type: Number, required: false },
    amount: { type: Number, required: false },
    currency: { type: String, required: false },
    orderStatus: { type: String, required: false },
  },
  { timestamps: true },
);

CashScanEventSchema.index({ cashierId: 1, createdAt: -1 });

CashScanEventSchema.plugin(autoIncrement, { model: 'CashScanEvent', field: 'id', startAt: 1 });
