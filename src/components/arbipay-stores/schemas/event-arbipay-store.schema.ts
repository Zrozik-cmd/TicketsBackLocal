import mongoose, { Schema, Document } from 'mongoose';

export const EVENT_ARBIPAY_STORE_STATUSES = [
  'pending',
  'active',
  'conflict',
  'failed',
] as const;
export type EventArbiPayStoreStatus = (typeof EVENT_ARBIPAY_STORE_STATUSES)[number];

/**
 * Точка (store) ARBIPAY события — своя коллекция, чтобы не расширять документ события.
 *
 * Строка пишется ДО запроса в микросервис (`pending`): тогда потерянный ответ не
 * превращается в бесконечные повторные создания, а крон дозаканчивает начатое.
 * Статусы: pending — запрос идёт или не удался (повторяемо), active — код точки
 * получен, conflict — код занят чужой точкой (нужно решение человека),
 * failed — определённый отказ (микросервис/ARBIPAY отвергли запрос).
 */
export interface IEventArbiPayStore extends Document {
  /** Event.id (числовой), одна точка на событие. */
  eventId: number;
  /** Код точки (slug) — его передают как metadata.storeCode при оплате. */
  code: string;
  /** Название, с которым точка создавалась (`#<id> <название события>`). */
  name: string;
  status: EventArbiPayStoreStatus;
  /** UUID точки в ARBIPAY (null, если известен только код). */
  storeId: string | null;
  /** Валюта, в которой точка фактически работает (effectiveCurrency ARBIPAY). */
  currency: string | null;
  /**
   * Хост платёжного микросервиса, через который создавалась точка: точка из другой
   * среды (другой микросервис → другой мерчант ARBIPAY) для нас не существует.
   */
  serviceHost: string;
  attempts: number;
  lastAttemptAt: Date | null;
  /**
   * Когда точка впервые стала active. Оплаты события, созданные раньше, прошли через
   * общую точку мерчанта — по этой отметке админка предупреждает о расхождении статистики.
   */
  activatedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export const EventArbiPayStoreSchema = new Schema<IEventArbiPayStore>(
  {
    eventId: { type: Number, required: true },
    code: { type: String, required: true, lowercase: true, trim: true },
    name: { type: String, required: true },
    status: {
      type: String,
      required: true,
      enum: EVENT_ARBIPAY_STORE_STATUSES,
      default: 'pending',
    },
    storeId: { type: String, required: false, default: null },
    currency: { type: String, required: false, default: null },
    serviceHost: { type: String, required: true },
    attempts: { type: Number, required: true, default: 0 },
    lastAttemptAt: { type: Date, required: false, default: null },
    activatedAt: { type: Date, required: false, default: null },
    lastError: { type: String, required: false, default: null },
  },
  { timestamps: true, collection: 'eventarbipaystores' },
);

// Одна точка на событие в пределах одной среды (микросервиса).
EventArbiPayStoreSchema.index({ eventId: 1, serviceHost: 1 }, { unique: true });
EventArbiPayStoreSchema.index({ status: 1, lastAttemptAt: 1 });

export function eventArbiPayStoreModel(): mongoose.Model<IEventArbiPayStore> {
  return (
    (mongoose.models.EventArbiPayStore as mongoose.Model<IEventArbiPayStore>) ??
    mongoose.model<IEventArbiPayStore>('EventArbiPayStore', EventArbiPayStoreSchema)
  );
}
