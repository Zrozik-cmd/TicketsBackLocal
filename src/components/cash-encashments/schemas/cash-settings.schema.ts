import { Schema, Document } from 'mongoose';

/** Единственный документ настроек кассового контура. */
export const CASH_SETTINGS_KEY = 'global';

/**
 * Глобальные настройки кассы, которые админ меняет из панели. Документ один
 * (ключ CASH_SETTINGS_KEY) и создаётся upsert-ом при первом сохранении —
 * пока его нет, действуют значения по умолчанию.
 *
 * Плагин autoinc не подключён по той же причине, что у ватерлинии: upsert
 * не выполняет save-хук автоинкремента.
 */
export interface ICashSettings extends Document {
  key: string;
  /**
   * Кому уходит письмо о пороге кассы. Пустой список — рассылка по умолчанию
   * (переменная CASH_TILL_ALERT_EMAIL, иначе все админы).
   */
  tillAlertEmails: string[];
  /** Кто последним сохранял настройки — для разбора. */
  updatedByAdminId?: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export const CashSettingsSchema = new Schema<ICashSettings>(
  {
    key: { type: String, required: true, unique: true, default: CASH_SETTINGS_KEY },
    tillAlertEmails: { type: [String], required: true, default: [] },
    updatedByAdminId: { type: Number, required: false, default: null },
  },
  { timestamps: true, collection: 'cash_settings' },
);
