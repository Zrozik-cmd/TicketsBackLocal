import { Schema, Document } from 'mongoose';

export type ScanStatus = 'used' | 'declined';

/** Why a scan was declined; absent on successful (`used`) rows. */
export const SCAN_DECLINE_REASONS = [
  'date_window',
  'wrong_event',
  'already_used',
  'not_active',
  'not_found',
  /** The ticket's session was cancelled by the organizer. */
  'session_cancelled',
] as const;
export type ScanDeclineReason = (typeof SCAN_DECLINE_REASONS)[number];

/**
 * One scanner attempt. Everything a support agent needs to reconstruct "why did this
 * ticket not scan" is denormalised onto the row on purpose: the ticket, order or even
 * the event may be edited or deleted later, but the scan history keeps the facts as
 * they were at the moment of scanning.
 */
export interface IScan extends Document {
  /** Ticket numeric id; `0` when the scanned code matched no ticket at all. */
  id: number;
  code: string;
  status: ScanStatus;
  moderatorId: number;
  moderatorEmail: string;
  date: Date;

  reason?: ScanDeclineReason;
  /** The exact text the cashier saw on the scanner. */
  message?: string;
  /** Event id the scanner was operating for (differs from `eventId` on wrong_event). */
  requestedEventId?: number;
  /** The ticket's own event. */
  eventId?: number;
  eventTitle?: string;
  orderId?: number;
  /** Show the ticket is for — regular events only. */
  sessionId?: number;
  sessionDate?: string;
  sessionStart?: string;
  sessionEnd?: string;
  customerId?: number;
  customerName?: string;
  customerEmail?: string;
  customerPhone?: string;
  price?: number;
  currency?: string;
  sectorId?: string;
  sectorName?: string;
  zoneId?: string;
  zoneName?: string;
}

export const ScanSchema = new Schema<IScan>(
  {
    id: { type: Number, required: true, index: true },
    code: { type: String, required: true, trim: true, index: true },
    status: { type: String, enum: ['used', 'declined'], required: true },
    moderatorId: { type: Number, required: true, index: true },
    moderatorEmail: { type: String, required: true, trim: true, lowercase: true },
    date: { type: Date, required: true, default: Date.now, index: true },

    reason: { type: String, enum: SCAN_DECLINE_REASONS, required: false },
    message: { type: String, required: false, trim: true },
    requestedEventId: { type: Number, required: false },
    eventId: { type: Number, required: false, index: true },
    eventTitle: { type: String, required: false, trim: true },
    orderId: { type: Number, required: false },
    sessionId: { type: Number, required: false },
    sessionDate: { type: String, required: false },
    sessionStart: { type: String, required: false },
    sessionEnd: { type: String, required: false },
    customerId: { type: Number, required: false },
    customerName: { type: String, required: false, trim: true },
    customerEmail: { type: String, required: false, trim: true },
    customerPhone: { type: String, required: false, trim: true },
    price: { type: Number, required: false },
    currency: { type: String, required: false },
    sectorId: { type: String, required: false },
    sectorName: { type: String, required: false, trim: true },
    zoneId: { type: String, required: false },
    zoneName: { type: String, required: false, trim: true },
  },
  { timestamps: false },
);

ScanSchema.index({ id: 1, date: -1 });
ScanSchema.index({ code: 1, date: -1 });
