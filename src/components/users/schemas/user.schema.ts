import { Schema, Document } from 'mongoose';
import { autoIncrement } from 'mongoose-plugin-autoinc';
import {
  DEFAULT_VAT_PERCENT,
  DEFAULT_PROCESSING_FEE_PERCENT,
  DEFAULT_PLATFORM_FEE_PERCENT,
  DEFAULT_ADDITIONAL_TICKET_COST_FEE_PERCENT,
} from '../../events/constants/event-fee-defaults.constant';

export interface IIdLabel {
  id: string;
  label: string;
}

/** Состояние заявки организатора на проверку документов. */
export const ORGANIZER_VERIFICATION_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type OrganizerVerificationStatus =
  (typeof ORGANIZER_VERIFICATION_STATUSES)[number];

export interface IUser extends Document {
  /** Auto-increment numeric id, used for all relations (JWT, events.creator, etc.) */
  id: number;
  email: string;
  phoneNumber: string;
  passwordHash?: string;
  emailVerified: boolean;
  phoneVerified: boolean;

  companyVenueName: string;
  displayName?: string;
  responsiblePersonFullName: string;
  category: IIdLabel;

  websiteOrSocialLink?: string;

  businessAddress: string;
  city?: string;
  provinceRegion: string;
  country?: string;

  shortDescription?: string;
  /**
   * Язык, на котором организатор зарегистрировался.
   *
   * Нужен для писем о его аккаунте: заказы носят локаль с собой, а у
   * организатора её взять неоткуда. Аккаунты до этого поля получают
   * английский — как и остальные письма без явной локали.
   */
  locale?: 'en' | 'ru' | 'th';
  taxRegistrationId?: string;
  /** Номер регистрации компании в DBD Таиланда. */
  companyRegistrationDbd?: string;
  /**
   * Медиа-id загруженной выписки DBD.
   *
   * Файл лежит в общей коллекции media, но публичным GET /media/:id его
   * отдавать нельзя: это официальный документ компании. Доступ — только
   * владельцу и админам, через отдельный защищённый маршрут.
   */
  companyRegistrationDbdMediaId?: number;
  eventsPerMonth?: string;

  /**
   * Проверка организатора платформой.
   *
   * Это НЕ то же самое, что status в списке админки: тот вычисляется на лету
   * («есть ли активные события») и к проверке документов отношения не имеет.
   * Здесь — состояние заявки: подана, одобрена или отклонена.
   */
  verificationStatus?: OrganizerVerificationStatus;
  verificationReviewedAt?: Date;
  /** Почта админа, принявшего решение — чтобы было с кого спросить. */
  verificationReviewedBy?: string;
  verificationRejectReason?: string;

  termsAcceptedAt?: Date;

  /** Default VAT % for new events this organizer creates (schema default if unset in DB). */
  defaultVatPercent?: number;
  /** Default payment processing fee % for new events. */
  defaultProcessingFeePercent?: number;
  /** Default platform fee % for new events. */
  defaultPlatformFeePercent?: number;
  /** Default additional ticket cost fee % (same basis as VAT); applied on new events. */
  defaultAdditionalTicketCostFeePercent?: number;

  createdAt: Date;
  updatedAt: Date;
}

const IdLabelSchema = new Schema(
  {
    id: { type: String, required: true },
    label: { type: String, required: true },
  },
  { _id: false },
);

export const UserSchema = new Schema<IUser>(
  {
    id: { type: Number, unique: true },
    email: { type: String, required: true, unique: true },
    phoneNumber: { type: String, required: true, unique: true },
    passwordHash: { type: String },
    emailVerified: { type: Boolean, default: false },
    phoneVerified: { type: Boolean, default: false },

    companyVenueName: { type: String, required: true },
    displayName: { type: String },
    responsiblePersonFullName: { type: String, required: true },
    category: { type: IdLabelSchema, required: true },

    websiteOrSocialLink: { type: String },

    businessAddress: { type: String, required: true },
    city: { type: String },
    provinceRegion: { type: String, required: true },
    country: { type: String },

    shortDescription: { type: String },
    locale: { type: String, enum: ['en', 'ru', 'th'], required: false },
    taxRegistrationId: { type: String },
    companyRegistrationDbd: { type: String },
    companyRegistrationDbdMediaId: { type: Number },
    eventsPerMonth: { type: String },

    verificationStatus: {
      type: String,
      enum: ORGANIZER_VERIFICATION_STATUSES,
      default: 'pending',
    },
    verificationReviewedAt: { type: Date },
    verificationReviewedBy: { type: String },
    verificationRejectReason: { type: String },

    termsAcceptedAt: { type: Date },

    defaultVatPercent: { type: Number, default: DEFAULT_VAT_PERCENT },
    defaultProcessingFeePercent: {
      type: Number,
      default: DEFAULT_PROCESSING_FEE_PERCENT,
    },
    defaultPlatformFeePercent: {
      type: Number,
      default: DEFAULT_PLATFORM_FEE_PERCENT,
    },
    defaultAdditionalTicketCostFeePercent: {
      type: Number,
      default: DEFAULT_ADDITIONAL_TICKET_COST_FEE_PERCENT,
    },
  },
  { timestamps: true },
);

UserSchema.plugin(autoIncrement, { model: 'User', field: 'id', startAt: 1 });
