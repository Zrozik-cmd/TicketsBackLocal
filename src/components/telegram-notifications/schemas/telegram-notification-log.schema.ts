import { Schema, Document } from 'mongoose';
import { autoIncrement } from 'mongoose-plugin-autoinc';
import {
  TELEGRAM_NOTIFICATION_LOG_STATUSES,
  type TelegramNotificationLogStatus,
} from '../constants/telegram.constants';

export interface ITelegramNotificationLog extends Document {
  id: number;
  orderId: number;
  telegramUserId: number;
  chatId: string;
  status: TelegramNotificationLogStatus;
  errorMessage?: string;
  sentAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export const TelegramNotificationLogSchema = new Schema<ITelegramNotificationLog>(
  {
    id: { type: Number, unique: true },
    orderId: { type: Number, required: true, index: true },
    telegramUserId: { type: Number, required: true, index: true },
    chatId: { type: String, required: true },
    status: {
      type: String,
      enum: TELEGRAM_NOTIFICATION_LOG_STATUSES,
      required: true,
    },
    errorMessage: { type: String, required: false },
    sentAt: { type: Date, required: false },
  },
  { timestamps: true, collection: 'telegram_notification_logs' },
);

TelegramNotificationLogSchema.index(
  { orderId: 1, telegramUserId: 1, status: 1 },
  { partialFilterExpression: { status: 'sent' } },
);

TelegramNotificationLogSchema.plugin(autoIncrement, {
  model: 'TelegramNotificationLog',
  field: 'id',
  startAt: 1,
});
