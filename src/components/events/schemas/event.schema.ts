import { Schema, Document } from 'mongoose';
import { autoIncrement } from 'mongoose-plugin-autoinc';
import { EVENT_STATUSES, type EventStatus } from '../constants/event-status.constant';
import {
  DEFAULT_VAT_PERCENT,
  DEFAULT_PROCESSING_FEE_PERCENT,
  DEFAULT_PLATFORM_FEE_PERCENT,
  DEFAULT_ADDITIONAL_TICKET_COST_FEE_PERCENT,
  DEFAULT_CASH_FEE_PERCENT,
} from '../constants/event-fee-defaults.constant';

export type { EventStatus };

export interface ILocalizedText {
  th?: string;
  en?: string;
  ru?: string;
}

export interface IEventDate {
  isRange: boolean;
  startDate: string;
  endDate?: string;
}

export interface ITime {
  allDay: boolean;
  start: string;
  end: string;
}

export interface IIdLabel {
  id: string;
  label: string;
}

/**
 * Гео-раздел афиши. Три города: сайт делит концерты на Пхукет, Паттайю и Бангкок
 * для отдельных страниц и рекламных кампаний. Не путать с province — провинций
 * 77, а разделов афиши три (Паттайя — город внутри провинции Чонбури).
 */
export const EVENT_CITIES = ['phuket', 'pattaya', 'bangkok'] as const;
export type EventCity = (typeof EVENT_CITIES)[number];

export interface IVenue {
  /** Название площадки, введённое организатором. Пусто у событий до разделения полей. */
  name?: string;
  address: string;
  placeId?: string;
  lat?: number;
  lng?: number;
}

export interface IZone {
  id: string;
  name: ILocalizedText;
  seats: number;
  remaining_tickets?: number;
  sold_tickets?: number;
  isFree: boolean;
  price: number;
  currency: string;
}

export interface ISector {
  id: string;
  color: string;
  name: ILocalizedText;
  zones: IZone[];
}

export interface IExternalLink {
  id: string;
  platform: string;
  displayName: string;
  url: string;
}

export interface IThbPaymentDetails {
  accountNumber: string;
  recipientName: string;
  phoneNumber: string;
  qrCodeImage?: number;
  hasCustomQrCode: boolean;
  useLegacyQrFallback: boolean;
}

export interface IEventPaymentOptions {
  thb: IThbPaymentDetails;
  cashEnabled: boolean;
}

export const REVIEW_AUDIENCES = ['everyone', 'buyers'] as const;
export type ReviewAudience = (typeof REVIEW_AUDIENCES)[number];

/**
 * Per-event review settings, managed by admins in lotus-admin (not by organizers).
 * Absent means reviews are on and limited to buyers — see `DEFAULT_REVIEW_SETTINGS`.
 */
export interface IEventReviewSettings {
  enabled: boolean;
  audience: ReviewAudience;
  /**
   * Lets customers review before the show has been performed. Off by default — a review
   * normally describes an event you attended — but useful for runs where feedback is
   * collected from rehearsals, previews or an ongoing season.
   */
  allowBeforeEvent: boolean;
}

export const DEFAULT_REVIEW_SETTINGS: IEventReviewSettings = {
  enabled: true,
  // Only actual ticket buyers may review unless an admin opens it up.
  audience: 'buyers',
  allowBeforeEvent: false,
};

/** One repeating show slot, e.g. `{ start: '14:30', end: '16:30' }`. Times are local ICT. */
export interface IRecurrenceSession {
  start: string;
  end: string;
}

export const RECURRENCE_STEP_MINUTES = [15, 30, 60] as const;
export type RecurrenceStepMinutes = (typeof RECURRENCE_STEP_MINUTES)[number];

/**
 * Repeating schedule for a regular event. Absent (or `enabled: false`) means the
 * event is a one-off and behaves exactly as before: a single `eventDate` + `time`.
 */
export interface IRecurrence {
  enabled: boolean;
  /** Inclusive bounds of the run, `YYYY-MM-DD`. */
  periodStart: string;
  periodEnd: string;
  /** Days the show runs on, `0` = Sunday … `6` = Saturday. */
  weekdays: number[];
  /** One or more show times per running day. */
  sessions: IRecurrenceSession[];
  /** Granularity the client renders start times at. */
  stepMinutes: RecurrenceStepMinutes;
  /** Individual `YYYY-MM-DD` dates skipped inside the period. */
  exceptions: string[];
}

export const SALES_CLOSE_BEFORE_UNITS = ['hours', 'days'] as const;
export type SalesCloseBeforeUnit = (typeof SALES_CLOSE_BEFORE_UNITS)[number];

/**
 * Automatic stop of ticket sales `value` hours/days before the start — of the event
 * for a one-off, of each session for a regular event. Absent or `enabled: false`
 * keeps the old behaviour. Math lives in `utils/sales-cutoff.util.ts`.
 */
export interface SalesCloseBefore {
  enabled: boolean;
  value: number;
  unit: SalesCloseBeforeUnit;
}

export const EVENT_TICKET_FORMATS = ['webp', 'pdf'] as const;
/** Format of the tickets attached to e-mails. A WebP image has no clickable links, a PDF has. */
export type EventTicketFormat = (typeof EVENT_TICKET_FORMATS)[number];

/**
 * One sponsor/partner of the ticket's "Sponsored by" block. `id` is client-generated
 * (`[A-Za-z0-9_-]{1,64}`, unique in its list); `name` and `url` are `''` when not given;
 * `url` is an absolute http(s) URL. Limits: `constants/event-sponsors.constant.ts`.
 */
export interface IEventSponsor {
  id: string;
  /** Media id of the logo (public media, rendered in a circle). */
  logo: number;
  name: string;
  url: string;
}

export interface IEvent extends Document {
  /** Auto-increment numeric id (for routes/relations) */
  id: number;
  /** User.id (numeric), set from JWT */
  creator: number;
  /** Event status; on create/update by organizer set to ACTIVE */
  status: EventStatus;
  title: ILocalizedText;
  coverImage: number;
  /**
   * Extra hero photos (Media ids) shown after the cover in the event-page
   * gallery. The cover stays the single "main" image every listing uses.
   */
  galleryImages?: number[];
  seatingPlanImage?: number;
  /** Total seats shown on the seating plan (informational). */
  seatingPlanSeats?: number;
  /**
   * Published seating-plan snapshot (constructor, `seating_plans.id`) whose sectors and
   * zones are the plan-generated part of `sectors` (ids `plan-…`). Written only by the
   * constructor's publish, never by the event DTOs.
   */
  seatingPlanId?: number;
  parkingPlanImage?: number;
  /** Total parking spots shown on the parking plan (informational). */
  parkingPlanSeats?: number;
  description: ILocalizedText;
  eventDate: IEventDate;
  time: ITime;
  category: IIdLabel;
  tags: IIdLabel[];
  province: IIdLabel;
  /** Гео-раздел афиши; отсутствует у событий, созданных до разделения. */
  city?: EventCity;
  venue: IVenue;
  eventLanguage: string;
  sectors: ISector[];
  externalLinks: IExternalLink[];
  refundPolicy?: ILocalizedText;
  paymentOptions?: IEventPaymentOptions;
  /**
   * Free-form venue working-hours line filled by the organizer, e.g.
   * "Open today: 10.30-19.00, Last entry at 18:00". Shown on the purchase page.
   */
  venueSchedule?: string;
  /** Present only on regular (recurring) events. */
  recurrence?: IRecurrence;
  /** Stop selling X hours/days before the start. Not a moderation-relevant change. */
  salesCloseBefore?: SalesCloseBefore | null;
  /**
   * Organizer's mailbox that receives an English copy of every ticket e-mail of this
   * event (entrance checks, lost-ticket support). Absent/empty = no copy. Private: never
   * part of a public event payload, not a moderation-relevant change.
   */
  ticketCopyEmail?: string;
  /**
   * Approved sponsors: what tickets render (absent or empty = no "Sponsored by" block).
   * Organizer edits of an event approved before wait in `pendingSponsors` instead (option B,
   * `constants/event-sponsors.constant.ts`); a never-approved event is written here directly.
   */
  sponsors?: IEventSponsor[];
  /**
   * Organizer's sponsor list awaiting admin approval, only on events approved before. Absent
   * when nothing is pending; `[]` when the organizer removed every sponsor. Not a status: the
   * event keeps selling with `sponsors`. Private: never part of a public event payload.
   */
  pendingSponsors?: IEventSponsor[];
  /** When the current pending list was (last) submitted. Private. */
  pendingSponsorsAt?: Date;
  /**
   * Format of the tickets attached to e-mails; absent = 'webp'. Any sponsor link requires
   * 'pdf' (400 `ticket_format_pdf_required`). Private: never part of a public event payload,
   * not a moderation-relevant change.
   */
  ticketFormat?: EventTicketFormat;
  /** Review on/off + who may leave one. Managed by admins, not organizers. */
  reviews?: IEventReviewSettings;
  /** Set when admin rejects a MODERATION application; cleared when published or resubmitted. */
  rejectReason?: string;
  /**
   * Organizer's "hide from site" switch (`PATCH /events/:id/visibility`). Not a status
   * and not a moderation-relevant change; not accepted by the create/update DTOs.
   * See `constants/event-visibility.constant.ts` for what it hides.
   */
  hiddenFromSite?: boolean;
  /** When the flag was last switched (either way). */
  hiddenFromSiteAt?: Date;
  /** Who switched it last: `user:<id>` or `manager:<id>`. */
  hiddenFromSiteBy?: string;
  /**
   * Organizer "archive": set instead of deleting an event that already has sales
   * (`POST /events/:id/remove`). Not a status, not a moderation change, not accepted by
   * the create/update DTOs. An archived event is off the site like a hidden one (see
   * `constants/event-visibility.constant.ts`) and cannot be edited until restored.
   */
  archivedByOrganizer?: boolean;
  /** When the flag was last switched (either way). */
  archivedByOrganizerAt?: Date;
  /** Who switched it last: `user:<id>` or `manager:<id>`. */
  archivedByOrganizerBy?: string;
  /**
   * Soft delete (`events/event-soft-delete.ts`): set instead of a hard delete when the event
   * has an ARBI Pay store, so the store code in the ARBI Pay cabinet keeps pointing at an event.
   * Such an event is also archived (off the site, no orders, no edits), disappears for the
   * organizer and stays listed, marked, in the admin panel. Not accepted by any DTO.
   */
  softDeleted?: boolean;
  softDeletedAt?: Date;
  /** `admin:<id>`, `user:<id>` or `manager:<id>`. */
  softDeletedBy?: string;
  /** VAT % applied to ticket subtotal (ex-VAT); source of truth for fee math. */
  vatPercent: number;
  /** Same basis as VAT: % of promo-adjusted subtotal. */
  additionalTicketCostFeePercent: number;
  processingFeePercent: number;
  platformFeePercent: number;
  /** Service commission on cash payments (%), on top of the VAT-inclusive total. */
  cashFeePercent: number;
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

const EventDateSchema = new Schema(
  {
    isRange: { type: Boolean, required: true },
    startDate: { type: String, required: true },
    endDate: { type: String },
  },
  { _id: false },
);

const TimeSchema = new Schema(
  {
    allDay: { type: Boolean, required: true },
    start: { type: String, required: true },
    end: { type: String, required: true },
  },
  { _id: false },
);

const IdLabelSchema = new Schema(
  {
    id: { type: String, required: true },
    label: { type: String, required: true },
  },
  { _id: false },
);

const VenueSchema = new Schema(
  {
    name: { type: String, required: false, trim: true },
    address: { type: String, required: true },
    placeId: { type: String },
    lat: { type: Number },
    lng: { type: Number },
  },
  { _id: false },
);

const ZoneSchema = new Schema(
  {
    id: { type: String, required: true },
    name: { type: LocalizedTextSchema, required: true },
    seats: { type: Number, required: true },
    isFree: { type: Boolean, required: true },
    price: { type: Number, required: true },
    currency: { type: String, required: true },
  },
  { _id: false },
);

const SectorSchema = new Schema(
  {
    id: { type: String, required: true },
    color: { type: String, required: true },
    name: { type: LocalizedTextSchema, required: true },
    zones: { type: [ZoneSchema], default: [] },
  },
  { _id: false },
);

const ExternalLinkSchema = new Schema(
  {
    id: { type: String, required: true },
    platform: { type: String, required: true },
    displayName: { type: String, default: '' },
    url: { type: String, default: '' },
  },
  { _id: false },
);

// Legacy manual THB receiver fields. PromptPay/card are issued by Omise now, so new
// events save these empty — they must not be `required` or validation would reject them.
const ThbPaymentDetailsSchema = new Schema(
  {
    accountNumber: { type: String, required: false, default: '' },
    recipientName: { type: String, required: false, default: '' },
    phoneNumber: { type: String, required: false, default: '' },
    qrCodeImage: { type: Number, required: false },
    hasCustomQrCode: { type: Boolean, default: false },
    useLegacyQrFallback: { type: Boolean, default: false },
  },
  { _id: false },
);

const EventPaymentOptionsSchema = new Schema(
  {
    thb: { type: ThbPaymentDetailsSchema, required: false },
    cashEnabled: { type: Boolean, default: false },
  },
  { _id: false },
);

const EventReviewSettingsSchema = new Schema(
  {
    enabled: { type: Boolean, default: true },
    audience: { type: String, enum: REVIEW_AUDIENCES, default: 'buyers' },
    allowBeforeEvent: { type: Boolean, default: false },
  },
  { _id: false },
);

const RecurrenceSessionSchema = new Schema(
  {
    start: { type: String, required: true },
    end: { type: String, required: true },
  },
  { _id: false },
);

const RecurrenceSchema = new Schema(
  {
    enabled: { type: Boolean, default: false },
    periodStart: { type: String, required: true },
    periodEnd: { type: String, required: true },
    weekdays: { type: [Number], default: [] },
    sessions: { type: [RecurrenceSessionSchema], default: [] },
    stepMinutes: { type: Number, enum: RECURRENCE_STEP_MINUTES, default: 60 },
    exceptions: { type: [String], default: [] },
  },
  { _id: false },
);

const SalesCloseBeforeSchema = new Schema(
  {
    enabled: { type: Boolean, default: false },
    value: { type: Number, required: true, min: 1, max: 720 },
    unit: { type: String, enum: SALES_CLOSE_BEFORE_UNITS, required: true },
  },
  { _id: false },
);

const EventSponsorSchema = new Schema(
  {
    id: { type: String, required: true },
    logo: { type: Number, required: true },
    name: { type: String, default: '' },
    url: { type: String, default: '' },
  },
  { _id: false },
);

export const EventSchema = new Schema<IEvent>(
  {
    id: { type: Number, unique: true },
    creator: { type: Number, required: true },
    status: { type: String, enum: EVENT_STATUSES, default: 'ACTIVE', required: true },
    title: { type: LocalizedTextSchema, required: true },
    coverImage: { type: Number, required: true },
    galleryImages: { type: [Number], required: false, default: undefined },
    seatingPlanImage: { type: Number, required: false },
    seatingPlanSeats: { type: Number, required: false },
    seatingPlanId: { type: Number, required: false },
    parkingPlanImage: { type: Number, required: false },
    parkingPlanSeats: { type: Number, required: false },
    description: { type: LocalizedTextSchema, required: true },
    eventDate: { type: EventDateSchema, required: true },
    time: { type: TimeSchema, required: true },
    category: { type: IdLabelSchema, required: true },
    tags: { type: [IdLabelSchema], default: [] },
    province: { type: IdLabelSchema, required: true },
    // required не ставим: старые документы живут без города, их добивает бутстрап-бэкфилл.
    city: { type: String, required: false, enum: EVENT_CITIES },
    venue: { type: VenueSchema, required: true },
    eventLanguage: { type: String, required: true },
    sectors: { type: [SectorSchema], default: [] },
    externalLinks: { type: [ExternalLinkSchema], default: [] },
    refundPolicy: { type: LocalizedTextSchema, required: false },
    paymentOptions: { type: EventPaymentOptionsSchema, required: false },
    venueSchedule: { type: String, required: false, trim: true },
    recurrence: { type: RecurrenceSchema, required: false },
    salesCloseBefore: { type: SalesCloseBeforeSchema, required: false },
    ticketCopyEmail: { type: String, required: false, trim: true, lowercase: true },
    sponsors: { type: [EventSponsorSchema], default: undefined },
    pendingSponsors: { type: [EventSponsorSchema], default: undefined },
    pendingSponsorsAt: { type: Date, required: false },
    ticketFormat: { type: String, enum: EVENT_TICKET_FORMATS, required: false },
    reviews: { type: EventReviewSettingsSchema, required: false },
    rejectReason: { type: String, required: false },
    hiddenFromSite: { type: Boolean, default: false },
    hiddenFromSiteAt: { type: Date, required: false },
    hiddenFromSiteBy: { type: String, required: false },
    archivedByOrganizer: { type: Boolean, default: false },
    archivedByOrganizerAt: { type: Date, required: false },
    archivedByOrganizerBy: { type: String, required: false },
    softDeleted: { type: Boolean, default: false },
    softDeletedAt: { type: Date, required: false },
    softDeletedBy: { type: String, required: false },
    vatPercent: { type: Number, default: DEFAULT_VAT_PERCENT },
    additionalTicketCostFeePercent: {
      type: Number,
      default: DEFAULT_ADDITIONAL_TICKET_COST_FEE_PERCENT,
    },
    processingFeePercent: {
      type: Number,
      default: DEFAULT_PROCESSING_FEE_PERCENT,
    },
    platformFeePercent: {
      type: Number,
      default: DEFAULT_PLATFORM_FEE_PERCENT,
    },
    cashFeePercent: {
      type: Number,
      default: DEFAULT_CASH_FEE_PERCENT,
    },
  },
  { timestamps: true },
);

EventSchema.plugin(autoIncrement, { model: 'Event', field: 'id', startAt: 1 });
