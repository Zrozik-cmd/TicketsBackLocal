import { Schema, Document } from "mongoose";

export const DELETED_EVENT_STATES = [
  "archived",
  "deleted",
  "rolled_back",
  "rollback_failed",
  "aborted",
] as const;
export type DeletedEventState = (typeof DELETED_EVENT_STATES)[number];

export const DELETED_EVENT_SOURCES = ["admin", "organizer"] as const;
export type DeletedEventSource = (typeof DELETED_EVENT_SOURCES)[number];

/**
 * Snapshot of a deleted event: audit record and the manual restore source. Written before
 * the event is deleted, both by an admin (`AdminEventsService.deleteEvent`) and by the
 * organizer deleting an event without sales (`EventRemovalService`, `source: "organizer"`).
 * Media files are intentionally kept, so the raw `event` document can be re-inserted as is
 * (event ids are never reused).
 */
export interface IDeletedEvent extends Document {
  eventId: number;
  eventStatus: string;
  creator: number;
  title?: unknown;
  /** Raw lean Event document incl. _id/timestamps (re-insertable). */
  event: Record<string, unknown>;
  /** Raw lean EventSession documents. */
  sessions: Record<string, unknown>[];
  /** Pre-cleanup manager assignments: { id, type, allEvents, events, event, createdByUserId }. */
  managers: Record<string, unknown>[];
  /** At delete time: AdminEventDeletionCounts (admin) or EventRemovalCounts (organizer). */
  counts: Record<string, unknown>;
  /** Who deleted it; snapshots written before the field existed are admin deletes. */
  source?: DeletedEventSource;
  /** Organizer deletes: `user:<id>` or `manager:<id>`. */
  deletedBy?: string;
  /** Admin deletes only; null for organizer deletes. */
  deletedByAdminId: number | null;
  /** Admin deletes only; empty for organizer deletes. */
  deletedByAdminEmail: string;
  deletedAt: Date;
  state: DeletedEventState;
  cleanupErrors: string[];
  createdAt: Date;
  updatedAt: Date;
}

export const DeletedEventSchema = new Schema<IDeletedEvent>(
  {
    eventId: { type: Number, required: true, index: true },
    eventStatus: { type: String, required: true },
    creator: { type: Number, required: true },
    title: { type: Schema.Types.Mixed, required: false },
    event: { type: Schema.Types.Mixed, required: true },
    // Same cast as CmsPageSchema.sections: mongoose typings expect subdocument schemas for object arrays.
    sessions: {
      type: [Schema.Types.Mixed],
      default: [],
    } as unknown as IDeletedEvent["sessions"],
    managers: {
      type: [Schema.Types.Mixed],
      default: [],
    } as unknown as IDeletedEvent["managers"],
    counts: { type: Schema.Types.Mixed, required: true },
    source: { type: String, enum: DELETED_EVENT_SOURCES, default: "admin" },
    deletedBy: { type: String, required: false },
    deletedByAdminId: { type: Number, default: null },
    deletedByAdminEmail: { type: String, default: "" },
    deletedAt: { type: Date, required: true },
    state: { type: String, enum: DELETED_EVENT_STATES, required: true },
    cleanupErrors: { type: [String], default: [] },
  },
  { timestamps: true, minimize: false, collection: "deletedevents" },
);
