import { Schema, Document } from 'mongoose';
import { autoIncrement } from 'mongoose-plugin-autoinc';

/**
 * - `active`    — on sale as usual.
 * - `disabled`  — system-only: the slot left the schedule but already had orders, so it
 *                 was kept instead of deleted (`disabledBySchedule`), and comes back
 *                 `active` when the slot returns. Rows the sync disabled before the flag
 *                 existed are flagged at boot (`healLegacyDisabledSessions`, which also
 *                 re-activates those whose slot is in the schedule). A flagless row that
 *                 still turns up stays closed — "sales closed" while its slot is in the
 *                 schedule, reopenable by the organizer.
 * - `sold_out`  — the organizer zeroed this session's quota: nothing can be bought.
 *                 Reversible back to `active`.
 * - `cancelled` — force majeure: irreversible, buyers are e-mailed, tickets are declined
 *                 at the door; the session stays visible on the storefront and in stats.
 */
export const EVENT_SESSION_STATUSES = ['active', 'disabled', 'sold_out', 'cancelled'] as const;
export type EventSessionStatus = (typeof EVENT_SESSION_STATUSES)[number];

/** What an organizer may switch a session to (cabinet PATCH and bulk action). */
export const ORGANIZER_SESSION_STATUSES = ['active', 'sold_out', 'cancelled'] as const;
export type OrganizerSessionStatus = (typeof ORGANIZER_SESSION_STATUSES)[number];

/**
 * One materialised show of a regular event.
 *
 * Sessions are generated from `event.recurrence` (period × weekdays × times, minus
 * exceptions) and stored so that each one can carry its own inventory, be listed in
 * the organizer cabinet, and be switched off individually without touching the event.
 *
 * `date`/`start`/`end` are plain local Thailand (ICT, UTC+7) strings, matching how
 * `event.eventDate` / `event.time` are already stored — no UTC conversion anywhere.
 */
export interface IEventSession extends Document {
  id: number;
  eventId: number;
  /** `YYYY-MM-DD` */
  date: string;
  /** `HH:mm` */
  start: string;
  /** `HH:mm` */
  end: string;
  status: EventSessionStatus;
  /**
   * Set only by the schedule sync when it disabled this session because its slot left
   * the schedule (and, once, by `healLegacyDisabledSessions` on rows that sync disabled
   * before the flag existed); cleared (and the session re-activated) once the slot is
   * wanted again.
   */
  disabledBySchedule?: boolean;
  /**
   * With `disabledBySchedule`: the organizer's status the sync took the session off from
   * when it was not `active` — only `sold_out` — so the returning slot restores it instead
   * of putting a closed show back on sale. Absent means it comes back `active`.
   */
  scheduleDisabledFrom?: 'sold_out';
  createdAt: Date;
  updatedAt: Date;
}

export const EventSessionSchema = new Schema<IEventSession>(
  {
    id: { type: Number, unique: true },
    eventId: { type: Number, required: true, index: true },
    date: { type: String, required: true },
    start: { type: String, required: true },
    end: { type: String, required: true },
    status: {
      type: String,
      enum: EVENT_SESSION_STATUSES,
      default: 'active',
      required: true,
    },
    // No default: only sessions the sync took off the schedule ever carry it.
    disabledBySchedule: { type: Boolean, required: false },
    scheduleDisabledFrom: { type: String, enum: ['sold_out'], required: false },
  },
  { timestamps: true },
);

/** Re-syncing an event upserts on this triple, so regeneration stays idempotent. */
EventSessionSchema.index({ eventId: 1, date: 1, start: 1 }, { unique: true });
EventSessionSchema.index({ eventId: 1, status: 1, date: 1 });
/** Across events: the cancellation-letter sweep reads the recently cancelled shows. */
EventSessionSchema.index({ status: 1, date: 1 });

EventSessionSchema.plugin(autoIncrement, {
  model: 'EventSession',
  field: 'id',
  startAt: 1,
});
