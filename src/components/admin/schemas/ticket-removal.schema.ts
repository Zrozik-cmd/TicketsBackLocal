import { Schema, Document } from "mongoose";

export const TICKET_REMOVAL_STATES = [
  "archived",
  "applied",
  "applied_with_errors",
  "aborted",
  "rolled_back",
  "rollback_failed",
] as const;
export type TicketRemovalState = (typeof TICKET_REMOVAL_STATES)[number];

/**
 * Archive of a silent ticket removal (admin vault): everything the removal changed or
 * deleted, written BEFORE anything is touched, so a developer can put it back by hand.
 * No statistics, registry or report reads this collection — that is the point of the
 * "without a trace" removal.
 */
export interface ITicketRemoval extends Document {
  orderId: number;
  eventId: number;
  ticketIds: number[];
  ticketCodes: string[];
  orderAction: "update" | "delete";
  /** Raw lean Ticket documents. */
  tickets: Record<string, unknown>[];
  /** Raw lean MockOrder document incl. _id/timestamps (re-insertable). */
  orderBefore: Record<string, unknown>;
  /** The `$set` applied to the order; null when the order was deleted. */
  orderAfterSet: Record<string, unknown> | null;
  /** Raw CASH ledger `sale` row before the rewrite (CASH orders only). */
  cashSaleRowBefore: Record<string, unknown> | null;
  /** New ledger sale amount; null when the row was deleted (or there was none). */
  cashSaleAmountAfter: number | null;
  /** Raw ReferralShare document before the change. */
  referralShareBefore: Record<string, unknown> | null;
  /** The `$inc` applied to ReferralLinkStats. */
  referralStatsDelta: Record<string, unknown> | null;
  /** `{ promoCodeId, customerId, decrement }`. */
  promo: Record<string, unknown> | null;
  /** Raw Scan documents of the removed tickets. */
  scans: Record<string, unknown>[];
  /** Raw CashScanEvent documents (only when the whole order is deleted). */
  cashScanEvents: Record<string, unknown>[];
  /** Raw TelegramNotificationLog documents (only when the whole order is deleted). */
  telegramLogs: Record<string, unknown>[];
  confirmation: string;
  removedByAdminId: number | null;
  removedByAdminEmail: string;
  state: TicketRemovalState;
  sideEffectErrors: string[];
  createdAt: Date;
  updatedAt: Date;
}

export const TicketRemovalSchema = new Schema<ITicketRemoval>(
  {
    orderId: { type: Number, required: true, index: true },
    eventId: { type: Number, required: true, index: true },
    ticketIds: { type: [Number], default: [], index: true },
    ticketCodes: { type: [String], default: [], index: true },
    orderAction: { type: String, enum: ["update", "delete"], required: true },
    // Same cast as DeletedEventSchema.sessions: mongoose typings expect subdocument schemas for object arrays.
    tickets: {
      type: [Schema.Types.Mixed],
      default: [],
    } as unknown as ITicketRemoval["tickets"],
    orderBefore: { type: Schema.Types.Mixed, required: true },
    orderAfterSet: { type: Schema.Types.Mixed, default: null },
    cashSaleRowBefore: { type: Schema.Types.Mixed, default: null },
    cashSaleAmountAfter: { type: Number, default: null },
    referralShareBefore: { type: Schema.Types.Mixed, default: null },
    referralStatsDelta: { type: Schema.Types.Mixed, default: null },
    promo: { type: Schema.Types.Mixed, default: null },
    scans: {
      type: [Schema.Types.Mixed],
      default: [],
    } as unknown as ITicketRemoval["scans"],
    cashScanEvents: {
      type: [Schema.Types.Mixed],
      default: [],
    } as unknown as ITicketRemoval["cashScanEvents"],
    telegramLogs: {
      type: [Schema.Types.Mixed],
      default: [],
    } as unknown as ITicketRemoval["telegramLogs"],
    confirmation: { type: String, required: true },
    removedByAdminId: { type: Number, default: null },
    removedByAdminEmail: { type: String, default: "" },
    state: { type: String, enum: TICKET_REMOVAL_STATES, required: true },
    sideEffectErrors: { type: [String], default: [] },
  },
  { timestamps: true, minimize: false, collection: "ticketremovals" },
);
