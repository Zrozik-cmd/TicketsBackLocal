import { Schema, Document } from 'mongoose';

export const MOCK_ORDER_STATUSES = ['wait', 'pending_cash', 'paid', 'failed', 'expired', 'cancelled', 'refunded'] as const;
export type MockOrderStatus = (typeof MOCK_ORDER_STATUSES)[number];

export const MOCK_ORDER_PAYMENT_METHODS = ['SVP', 'QR', 'CRYPTO', 'CASH', 'ALIPAY', 'CARD'] as const;
export type MockOrderPaymentMethod = (typeof MOCK_ORDER_PAYMENT_METHODS)[number];

export const REFUND_STATUSES = ['none', 'refund_in_progress', 'refunded', 'cancelled'] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

export const REFUND_HISTORY_STATUSES = ['refund_in_progress', 'refunded', 'cancelled'] as const;
export type RefundHistoryStatus = (typeof REFUND_HISTORY_STATUSES)[number];

export interface IMockOrderRefund {
  status: RefundHistoryStatus;
  originalPaidAmount: number;
  originalCurrency: string;
  grossAmountTHB: number;
  processingFeeTHB: number;
  platformFeeTHB: number;
  vatTHB: number;
  additionalFeeTHB: number;
  /** Bank-card surcharge withheld from the refund (THB); absent on pre-surcharge snapshots. */
  bankCardFeeTHB?: number;
  /** Cash-payment fee withheld from the refund (THB); absent on pre-cash-fee snapshots. */
  cashFeeTHB?: number;
  totalCommissionTHB: number;
  exchangeRate: number;
  commissionInOriginalCurrency: number;
  refundAmount: number;
  createdAt: Date;
  createdBy: string;
  completedAt?: Date;
  completedBy?: string;
  cancelledAt?: Date;
  cancelledBy?: string;
  comment?: string;
}

export const MOCK_ORDER_PAYMENT_CURRENCIES = ['RUB', 'USDT', 'KZT', 'THB'] as const;
export type MockOrderPaymentCurrency =
  (typeof MOCK_ORDER_PAYMENT_CURRENCIES)[number];

export interface IMockOrderTicket {
  sectorId: string;
  zoneId: string;
  price: number;
  currency: string;
  count: number;
  /**
   * EventSession.id, set only for regular (recurring) events. Lines of one order may
   * point at different sessions, so a customer can book several shows in one go.
   */
  session?: number;
  /** Denormalised session date/time, mirrored onto the issued tickets. */
  sessionDate?: string;
  sessionStart?: string;
  sessionEnd?: string;
  /** Места схемы зала, закреплённые за строкой (seat-holds); i-й билет — i-е место. */
  seats?: { id: number; label: string }[];
}

/**
 * One issued ticket as it was when its order was refunded. Completing a refund deletes
 * the Ticket documents, so this frozen copy is what the organizer's ticket registry
 * lists as "refunded" (and what a forged PDF of such a ticket is checked against).
 */
export interface IMockOrderRefundedTicket {
  /** Ticket.id — never reused, the counter only grows. */
  id: number;
  code: string;
  customer: number;
  sector: string;
  zone: string;
  price: number;
  currency: string;
  /** Ticket status at the moment of the refund (`ACTIVE` or `USED`). */
  status: string;
  session?: number;
  sessionDate?: string;
  sessionStart?: string;
  sessionEnd?: string;
  created: Date;
}

export interface IMockOrder extends Document {
  id: number;
  event: number;
  customer: number;
  paymentCurrency: MockOrderPaymentCurrency;
  paymentMethod?: MockOrderPaymentMethod;
  price: number;
  total_price: number;
  /** VAT amount (same currency as `price`), line item before total. */
  vat: number;
  /** Additional ticket cost fee amount (same basis as VAT). */
  additionalTicketCostFee: number;
  /** Bank-card surcharge (THB), charged on top of the VAT-inclusive total; 0 for non-card payments. */
  bankCardFee?: number;
  /** Service commission on cash payments (THB), same basis as the card surcharge; 0 otherwise. */
  cashFee?: number;
  /** Amount paid by the customer in `paymentCurrency` (e.g. RUB for SBP, USDT for crypto, THB for Omise). */
  originalPaidAmount?: number;
  status: MockOrderStatus;
  locale?: 'en' | 'ru' | 'th';
  ticketEmailStatus?: 'pending' | 'sent' | 'failed';
  ticketEmailAttempts?: number;
  ticketEmailLastError?: string;
  ticketEmailLastSentAt?: Date;
  ticketEmailNextRetryAt?: Date;
  /**
   * When the English copy of the tickets went to the event's `ticketCopyEmail`. Set
   * once; retries and resends of the buyer's e-mail never send a second copy.
   */
  ticketCopyEmailSentAt?: Date;
  /** Failed copy attempts (render or SMTP); the copy is retried while below the limit. */
  ticketCopyEmailAttempts?: number;
  ticketCopyEmailLastError?: string;
  ticketCopyEmailNextRetryAt?: Date;
  /**
   * Cancelled sessions whose cancellation letter this order's buyer has been sent (handed
   * to the mailer). Whatever is cancelled and not listed here is still owed a letter.
   */
  sessionCancellationNotifiedFor?: number[];
  /** Failed cancellation-letter attempts in a row; the letter is retried while below the limit. */
  sessionCancellationEmailAttempts?: number;
  sessionCancellationEmailLastError?: string;
  tickets: IMockOrderTicket[];
  /** Customer ticked the email-marketing consent checkbox at checkout; pushed to Mailchimp once paid. */
  newsletterOptIn?: boolean;
  promoCodeId?: string;
  promoTicketCount?: number;
  /** Subtotal discount amount applied from the promo (same currency as order subtotal), before VAT. */
  promocodeDiscount?: number;
  createdAt: Date;
  updatedAt: Date;
  selectedPos?: string;
  actualPos?: string;
  cashierEmail?: string;
  /** Неизменяемый ключ кассира, подтвердившего оплату (0 — админ). Email — только для отображения. */
  cashierId?: number;
  paymentConfirmedAt?: Date;
  cashBookingExpiresAt?: Date;
  /**
   * Who voided the booking — a cashier's email, "admin", or "customer".
   * Kept apart from `cashierEmail` (which means "who took the money"), so a
   * cancelled order never reads as one that was paid for.
   */
  cancelledBy?: string;
  cancelledAt?: Date;
  /** Till the cancellation was made at, mirroring `actualPos` for payments. */
  cancelledPos?: string;
  /**
   * Human-friendly code of a cash booking (e.g. "7KF3QM") — what the customer
   * shows the cashier as a QR or reads out loud. Only cash bookings have one;
   * card orders never do.
   */
  bookingCode?: string;

  refundStatus: RefundStatus;
  /** Email of the admin who last changed `refundStatus`. */
  refundStatusChangedByEmail?: string;
  /** Refund calculation snapshot and action history. */
  refund?: IMockOrderRefund;
  /** The order's tickets frozen right before a completed refund deleted them. */
  refundedTickets?: IMockOrderRefundedTicket[];
}

const MockOrderTicketSchema = new Schema(
  {
    sectorId: { type: String, required: true },
    zoneId: { type: String, required: true },
    price: { type: Number, required: true },
    currency: { type: String, required: true },
    count: { type: Number, required: true },
    session: { type: Number, required: false },
    sessionDate: { type: String, required: false },
    sessionStart: { type: String, required: false },
    sessionEnd: { type: String, required: false },
    seats: { type: [{ id: Number, label: String, _id: false }], default: undefined },
  },
  { _id: false },
);

const MockOrderRefundSchema = new Schema<IMockOrderRefund>(
  {
    status: { type: String, enum: REFUND_HISTORY_STATUSES, required: true },
    originalPaidAmount: { type: Number, required: true },
    originalCurrency: { type: String, required: true },
    grossAmountTHB: { type: Number, required: true },
    processingFeeTHB: { type: Number, required: true },
    platformFeeTHB: { type: Number, required: true },
    vatTHB: { type: Number, required: true },
    additionalFeeTHB: { type: Number, required: true },
    bankCardFeeTHB: { type: Number, required: false, default: 0 },
    cashFeeTHB: { type: Number, required: false, default: 0 },
    totalCommissionTHB: { type: Number, required: true },
    exchangeRate: { type: Number, required: true },
    commissionInOriginalCurrency: { type: Number, required: true },
    refundAmount: { type: Number, required: true },
    createdAt: { type: Date, required: true },
    createdBy: { type: String, required: true, trim: true, lowercase: true },
    completedAt: { type: Date, required: false },
    completedBy: { type: String, required: false, trim: true, lowercase: true },
    cancelledAt: { type: Date, required: false },
    cancelledBy: { type: String, required: false, trim: true, lowercase: true },
    comment: { type: String, required: false, trim: true },
  },
  { _id: false },
);

const MockOrderRefundedTicketSchema = new Schema<IMockOrderRefundedTicket>(
  {
    id: { type: Number, required: true },
    code: { type: String, required: true },
    customer: { type: Number, required: true },
    sector: { type: String, required: true },
    zone: { type: String, required: true },
    price: { type: Number, required: true },
    currency: { type: String, required: true },
    status: { type: String, required: true },
    session: { type: Number, required: false },
    sessionDate: { type: String, required: false },
    sessionStart: { type: String, required: false },
    sessionEnd: { type: String, required: false },
    created: { type: Date, required: true },
  },
  { _id: false },
);

export const MockOrderSchema = new Schema<IMockOrder>(
  {
    id: { type: Number, unique: true },
    event: { type: Number, required: true },
    customer: { type: Number, required: true },
    paymentCurrency: {
      type: String,
      enum: MOCK_ORDER_PAYMENT_CURRENCIES,
      required: true,
      default: 'RUB',
    },
    paymentMethod: {
      type: String,
      enum: MOCK_ORDER_PAYMENT_METHODS,
      required: false,
    },
    price: { type: Number, required: true },
    total_price: { type: Number, required: true },
    vat: { type: Number, required: true },
    additionalTicketCostFee: { type: Number, required: true },
    bankCardFee: { type: Number, required: false, default: 0 },
    cashFee: { type: Number, required: false, default: 0 },
    originalPaidAmount: { type: Number, required: false },
    status: { type: String, enum: MOCK_ORDER_STATUSES, default: 'wait', required: true },
    locale: { type: String, enum: ['en', 'ru', 'th'], required: false, default: 'en' },
    ticketEmailStatus: { type: String, enum: ['pending', 'sent', 'failed'], required: false },
    ticketEmailAttempts: { type: Number, required: false, default: 0 },
    ticketEmailLastError: { type: String, required: false },
    ticketEmailLastSentAt: { type: Date, required: false },
    ticketEmailNextRetryAt: { type: Date, required: false },
    ticketCopyEmailSentAt: { type: Date, required: false },
    ticketCopyEmailAttempts: { type: Number, required: false },
    ticketCopyEmailLastError: { type: String, required: false },
    ticketCopyEmailNextRetryAt: { type: Date, required: false },
    // No default: only orders on a cancelled session ever carry it.
    sessionCancellationNotifiedFor: { type: [Number], required: false, default: undefined },
    sessionCancellationEmailAttempts: { type: Number, required: false },
    sessionCancellationEmailLastError: { type: String, required: false },
    tickets: { type: [MockOrderTicketSchema], default: [] },
    newsletterOptIn: { type: Boolean, required: false },
    promoCodeId: { type: String, required: false },
    promoTicketCount: { type: Number, required: false, min: 1 },
    promocodeDiscount: { type: Number, required: false, min: 0 },
    selectedPos: { type: String, required: false, trim: true },
    actualPos: { type: String, required: false, trim: true },
    cashierEmail: { type: String, required: false, trim: true, lowercase: true },
    cashierId: { type: Number, required: false },
    paymentConfirmedAt: { type: Date, required: false },
    cashBookingExpiresAt: { type: Date, required: false },
    cancelledBy: { type: String, required: false, trim: true, lowercase: true },
    cancelledAt: { type: Date, required: false },
    cancelledPos: { type: String, required: false, trim: true },
    bookingCode: { type: String, required: false, trim: true, uppercase: true },
    // (unique sparse index declared below, next to the schema's other indexes)
    refundStatus: { type: String, enum: REFUND_STATUSES, default: 'none', required: true },
    refundStatusChangedByEmail: { type: String, required: false, trim: true, lowercase: true },
    refund: { type: MockOrderRefundSchema, required: false },
    // No default: only orders refunded after the registry shipped carry a snapshot.
    refundedTickets: { type: [MockOrderRefundedTicketSchema], required: false, default: undefined },
  },
  { timestamps: true },
);

/** One booking code maps to at most one order; card orders carry none. */
MockOrderSchema.index({ bookingCode: 1 }, { unique: true, sparse: true });

/** Статистика кассира: подтверждённые CASH-заказы по неизменяемому id за период. */
MockOrderSchema.index({ paymentMethod: 1, status: 1, cashierId: 1, paymentConfirmedAt: -1 });

/** Per-event reads — sales statistics, paid-order lists, the ticket registry. */
MockOrderSchema.index({ event: 1, status: 1 });
