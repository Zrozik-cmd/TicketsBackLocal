import { Schema, Document } from 'mongoose';
import { autoIncrement } from 'mongoose-plugin-autoinc';

export interface IUserTelegramUser extends Document {
  id: number;
  userId: number;
  telegramUserId: number;
  notificationsEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export const UserTelegramUserSchema = new Schema<IUserTelegramUser>(
  {
    id: { type: Number, unique: true },
    userId: { type: Number, required: true, index: true },
    telegramUserId: { type: Number, required: true, index: true },
    notificationsEnabled: { type: Boolean, required: true, default: true },
  },
  { timestamps: true, collection: 'user_telegram_users' },
);

UserTelegramUserSchema.index({ userId: 1, telegramUserId: 1 }, { unique: true });

UserTelegramUserSchema.plugin(autoIncrement, {
  model: 'UserTelegramUser',
  field: 'id',
  startAt: 1,
});
