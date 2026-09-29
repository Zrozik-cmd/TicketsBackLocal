import { Schema, Document } from 'mongoose';
import { autoIncrement } from 'mongoose-plugin-autoinc';
import type { ILocalizedText } from '../../events/schemas/event.schema';

export interface ILocalizedImage {
  th?: number;
  en?: number;
  ru?: number;
}

export interface IBanner extends Document {
  id: number;
  tag?: ILocalizedText;
  title?: ILocalizedText;
  description?: ILocalizedText;
  buttonText?: ILocalizedText;
  bgImage: ILocalizedImage | number;
  href: string;
  sortOrder: number;
  isActive: boolean;
  scheduleEnabled: boolean;
  startsAt?: Date;
  endsAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const LocalizedTextSchema = new Schema(
  {
    th: { type: String, default: '' },
    en: { type: String, default: '' },
    ru: { type: String, default: '' },
  },
  { _id: false },
);

const LocalizedImageSchema = new Schema(
  {
    th: { type: Number, required: false },
    en: { type: Number, required: false },
    ru: { type: Number, required: false },
  },
  { _id: false },
);

export const BannerSchema = new Schema<IBanner>(
  {
    id: { type: Number, unique: true },
    tag: { type: LocalizedTextSchema, required: false },
    title: { type: LocalizedTextSchema, required: false },
    description: { type: LocalizedTextSchema, required: false },
    buttonText: { type: LocalizedTextSchema, required: false },
    bgImage: { type: LocalizedImageSchema, required: true },
    href: { type: String, required: true, trim: true },
    sortOrder: { type: Number, required: true, default: 0 },
    isActive: { type: Boolean, required: true, default: true },
    scheduleEnabled: { type: Boolean, required: true, default: false },
    startsAt: { type: Date, required: false },
    endsAt: { type: Date, required: false },
  },
  { timestamps: true },
);

BannerSchema.plugin(autoIncrement, { model: 'Banner', field: 'id', startAt: 1 });

BannerSchema.index({ isActive: 1, sortOrder: 1 });
BannerSchema.index({ sortOrder: 1 });
