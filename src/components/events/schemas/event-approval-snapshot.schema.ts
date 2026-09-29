import { Schema } from 'mongoose';
import type { EventModerationShape } from '../utils/event-moderation-shape.util';

export const EVENT_APPROVAL_SNAPSHOTS_COLLECTION = 'event_approval_snapshots';

/**
 * What an admin last approved for one event: its moderation shape right after the approval
 * (`utils/event-moderation-shape.util.ts`). One document per event, replaced on every
 * approval (confirm, sponsors approve). It serves two purposes:
 * - the admin detail diffs it against the current event ("changed since the last approval");
 * - its presence means "approved at least once", so organizer sponsor edits wait for review
 *   instead of reaching tickets (option B).
 * Admin edits of reviewed fields (description, cash switch, sponsor removal) are written
 * into `data` too, so they never read as organizer changes.
 */
export interface IEventApprovalSnapshot {
  /** Event.id (numeric). */
  eventId: number;
  /** When the approval happened; for boot-time baselines, the event's `updatedAt`. */
  approvedAt: Date;
  /** Admin.id who approved; `null` for boot-time baselines of already published events. */
  approvedByAdminId: number | null;
  /** Canonical moderation shape; sponsors are the approved list. */
  data: EventModerationShape;
}

export const EventApprovalSnapshotSchema = new Schema<IEventApprovalSnapshot>(
  {
    eventId: { type: Number, required: true, unique: true },
    approvedAt: { type: Date, required: true },
    approvedByAdminId: { type: Number, default: null },
    data: { type: Schema.Types.Mixed, default: {} },
  },
  { collection: EVENT_APPROVAL_SNAPSHOTS_COLLECTION, minimize: false, versionKey: false },
);
