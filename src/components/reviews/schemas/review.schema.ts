import { Schema, Document, Query, UpdateQuery } from 'mongoose';
import { autoIncrement } from 'mongoose-plugin-autoinc';

export const REVIEW_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/** Photo cap per review — mirrored by the DTO and the customer-facing form. */
export const REVIEW_MAX_PHOTOS = 5;

/**
 * A customer review of an event.
 *
 * Reviews are always created as `pending`: the author sees their own review right
 * away, everyone else only after a moderator approves it (in lotus-admin or straight
 * from the Telegram moderation chat).
 */
export interface IReview extends Document {
  id: number;
  eventId: number;
  /** Customer.id of the author. */
  customer: number;
  /** Snapshot of the author's name, so the review survives profile edits. */
  authorName: string;
  rating: number;
  message: string;
  /** Media ids of photos the customer attached (up to `REVIEW_MAX_PHOTOS`). */
  photos?: number[];
  status: ReviewStatus;
  /** Set when a moderator rejects the review. */
  rejectReason?: string;
  moderatedAt?: Date;
  /** Who moderated: admin email or `telegram:<user id>`. */
  moderatedBy?: string;
  /**
   * When a moderator last approved this review. Never cleared, including on a
   * later rejection: its presence is the record that the review already passed
   * moderation once, which is what keeps it out of the queue afterwards.
   */
  approvedAt?: Date;
  created: Date;
}

export const ReviewSchema = new Schema<IReview>(
  {
    id: { type: Number, unique: true },
    eventId: { type: Number, required: true, index: true },
    customer: { type: Number, required: true, index: true },
    authorName: { type: String, required: true, trim: true },
    rating: { type: Number, required: true, min: 1, max: 5 },
    message: { type: String, required: true, trim: true, maxlength: 2000 },
    photos: { type: [Number], required: false, default: undefined },
    status: {
      type: String,
      enum: REVIEW_STATUSES,
      default: 'pending',
      required: true,
      index: true,
    },
    rejectReason: { type: String, required: false, trim: true },
    moderatedAt: { type: Date, required: false },
    moderatedBy: { type: String, required: false, trim: true },
    approvedAt: { type: Date, required: false },
    created: { type: Date, required: true, default: Date.now },
  },
  { timestamps: false },
);

/**
 * A review that has already been approved never goes back into the moderation
 * queue. An event returning to moderation re-checks the event, not the reviews
 * under it, and making moderators re-approve the same reviews after every
 * organizer edit loses real work. Any write that sets `pending` is therefore
 * narrowed to reviews that are not approved right now and were not approved
 * before — the current status covers rows that predate `approvedAt`, the marker
 * covers rows a moderator has since rejected.
 *
 * Only the queue state is protected: a moderator can still reject an approved
 * review, because that is an explicit decision rather than a reset.
 */
function keepApprovedOutOfQueue(this: Query<unknown, IReview>): void {
  const update = this.getUpdate() as UpdateQuery<IReview> | null;
  if (!update || Array.isArray(update)) return;
  const next =
    (update.$set as { status?: ReviewStatus } | undefined)?.status ??
    (update as { status?: ReviewStatus }).status;
  if (next !== 'pending') return;
  this.where({ status: { $ne: 'approved' }, approvedAt: { $exists: false } });
}

ReviewSchema.pre('findOneAndUpdate', keepApprovedOutOfQueue);
ReviewSchema.pre('updateOne', keepApprovedOutOfQueue);
ReviewSchema.pre('updateMany', keepApprovedOutOfQueue);

/** Same guarantee for document saves, which bypass the query hooks above. */
ReviewSchema.pre('save', function (next) {
  if (!this.isNew && this.status === 'pending' && this.approvedAt) {
    this.status = 'approved';
  }
  next();
});

/** One review per customer per event. */
ReviewSchema.index({ eventId: 1, customer: 1 }, { unique: true });

ReviewSchema.plugin(autoIncrement, { model: 'Review', field: 'id', startAt: 1 });
