import { Schema, Document } from 'mongoose';
import { autoIncrement } from 'mongoose-plugin-autoinc';
import {
  TELEGRAM_USER_STATUSES,
  type TelegramUserStatus,
} from '../constants/telegram.constants';

export interface ITelegramUser extends Document {
  id: number;
  usernameFromAdmin: string;
  realTelegramUserId?: string;
  realTelegramUsername?: string;
  chatId?: string;
  status: TelegramUserStatus;
  startedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export const TelegramUserSchema = new Schema<ITelegramUser>(
  {
    id: { type: Number, unique: true },
    usernameFromAdmin: { type: String, required: true, trim: true, lowercase: true },
    realTelegramUserId: { type: String, required: false, default: null },
    realTelegramUsername: { type: String, required: false, default: null },
    chatId: { type: String, required: false, default: null, index: true },
    status: {
      type: String,
      enum: TELEGRAM_USER_STATUSES,
      required: true,
      default: 'pending',
    },
    startedAt: { type: Date, required: false },
  },
  { timestamps: true, collection: 'telegram_users' },
);

TelegramUserSchema.index({ usernameFromAdmin: 1 });
TelegramUserSchema.index({ realTelegramUserId: 1 });

TelegramUserSchema.plugin(autoIncrement, {
  model: 'TelegramUser',
  field: 'id',
  startAt: 1,
});
