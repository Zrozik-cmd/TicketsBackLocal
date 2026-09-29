import { Schema, Document } from 'mongoose';
import { autoIncrement } from 'mongoose-plugin-autoinc';
import {
  TICKET_STATUSES,
  type TicketStatus,
  TICKET_STATUS_DEFAULT,
} from '../constants/ticket-status.constant';

export type { TicketStatus };

export interface ITicket extends Document {
  id: number;
  customer: number;
  orderId: number;
  eventId: number;
  sector: string;
  zone: string;
  price: number;
  currency: string;
  code: string;
  status: TicketStatus;
  /** EventSession.id — set only for regular (recurring) events. */
  session?: number;
  /**
   * Denormalised session date/time so the printed ticket keeps showing the exact
   * show it was bought for even if the schedule is edited later.
   */
  sessionDate?: string;
  sessionStart?: string;
  sessionEnd?: string;
  /** Место схемы зала (SeatingPlanSeat.id) и его подпись, если билет куплен по схеме. */
  seatId?: number;
  seatLabel?: string;
  created: Date;
}

export const TicketSchema = new Schema<ITicket>(
  {
    id: { type: Number, unique: true },
    customer: { type: Number, required: true },
    orderId: { type: Number, required: true, index: true },
    eventId: { type: Number, required: true, index: true },
    sector: { type: String, required: true },
    zone: { type: String, required: true },
    price: { type: Number, required: true },
    currency: { type: String, required: true },
    code: { type: String, required: true, unique: true, index: true },
    status: {
      type: String,
      enum: TICKET_STATUSES,
      default: TICKET_STATUS_DEFAULT,
      required: true,
    },
    session: { type: Number, required: false, index: true },
    sessionDate: { type: String, required: false },
    sessionStart: { type: String, required: false },
    sessionEnd: { type: String, required: false },
    seatId: { type: Number, required: false, index: true },
    seatLabel: { type: String, required: false },
    created: { type: Date, required: true, default: Date.now },
  },
  { timestamps: false },
);

TicketSchema.plugin(autoIncrement, { model: 'Ticket', field: 'id', startAt: 1 });
