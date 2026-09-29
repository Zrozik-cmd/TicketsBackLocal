import mongoose, { Schema } from 'mongoose';
import { HOME_HERO_RESET_REASONS, HOME_HERO_SETTING_KEY, type HomeHeroResetReason } from '../constants/home-hero.constants';

/**
 * Настройка первого экрана: закреплённое админом событие или `null` (режим по умолчанию).
 * Документ один (ключ HOME_HERO_SETTING_KEY) и создаётся upsert-ом при первом выборе —
 * пока его нет, действует режим по умолчанию. Автоинкремент не нужен (как у cash_settings).
 */
export interface IHomeHeroSetting {
  key: string;
  eventId: number | null;
  /** Когда и кем событие закреплено. */
  setAt: Date | null;
  setByAdminId: number | null;
  setByLabel: string | null;
  /** Когда и почему закрепление снято последний раз. */
  resetAt: Date | null;
  resetReason: HomeHeroResetReason | null;
  /** Какое событие было снято (для разбора). */
  resetEventId: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export const HomeHeroSettingSchema = new Schema<IHomeHeroSetting>(
  {
    key: { type: String, required: true, unique: true, default: HOME_HERO_SETTING_KEY },
    eventId: { type: Number, required: false, default: null },
    setAt: { type: Date, required: false, default: null },
    setByAdminId: { type: Number, required: false, default: null },
    setByLabel: { type: String, required: false, default: null },
    resetAt: { type: Date, required: false, default: null },
    resetReason: { type: String, enum: [...HOME_HERO_RESET_REASONS, null], required: false, default: null },
    resetEventId: { type: Number, required: false, default: null },
  },
  { timestamps: true, collection: 'home_hero_settings' },
);

export function homeHeroSettingModel(): mongoose.Model<IHomeHeroSetting> {
  return (
    (mongoose.models.HomeHeroSetting as mongoose.Model<IHomeHeroSetting>) ??
    mongoose.model<IHomeHeroSetting>('HomeHeroSetting', HomeHeroSettingSchema)
  );
}
