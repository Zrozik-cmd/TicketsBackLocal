import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import mongoose from 'mongoose';
import {
  IReview,
  ReviewSchema,
  type ReviewStatus,
} from './schemas/review.schema';
import {
  DEFAULT_REVIEW_SETTINGS,
  EventSchema,
  IEvent,
  type IEventReviewSettings,
  type ILocalizedText,
} from '../events/schemas/event.schema';
import { VISIBLE_ON_SITE_FILTER } from '../events/constants/event-visibility.constant';
import {
  EventSessionSchema,
  IEventSession,
} from '../event-sessions/schemas/event-session.schema';
import { ITicket, TicketSchema } from '../tickets/schemas/ticket.schema';

/** Thailand is UTC+7 and sessions are stored as local wall-clock strings. */
const ICT_OFFSET_MS = 7 * 60 * 60 * 1000;
import { IMockOrder, MockOrderSchema } from '../mock-orders/schemas/mock-order.schema';
import { ICustomer, CustomerSchema } from '../customers/schemas/customer.schema';
import { CreateReviewDto } from './dto/create-review.dto';
import { MediaService } from '../media/media.service';
import { EventMessengersNotifierService } from '../event-messengers/services/event-messengers-notifier.service';

export type ReviewRatingAggregate = {
  ratingAvg: number;
  ratingCount: number;
  /** Counts per star, index 0 = 1 star … index 4 = 5 stars. */
  histogram: number[];
};

export type PublicReview = {
  id: number;
  rating: number;
  message: string;
  authorName: string;
  created: Date;
  status: ReviewStatus;
  /** Media ids — the client renders each as `/media/:id`. Empty when none. */
  photos: number[];
  /** True for the requesting customer's own review (may still be pending). */
  isOwn: boolean;
};

@Injectable()
export class ReviewsService {
  private readonly logger = new Logger(ReviewsService.name);

  constructor(
    private readonly mediaService: MediaService,
    private readonly messengersNotifier: EventMessengersNotifierService,
  ) {}

  private get reviewModel(): mongoose.Model<IReview> {
    return (
      (mongoose.models.Review as mongoose.Model<IReview>) ??
      mongoose.model<IReview>('Review', ReviewSchema)
    );
  }

  private get eventModel(): mongoose.Model<IEvent> {
    return (
      (mongoose.models.Event as mongoose.Model<IEvent>) ??
      mongoose.model<IEvent>('Event', EventSchema)
    );
  }

  private get ticketModel(): mongoose.Model<ITicket> {
    return (
      (mongoose.models.Ticket as mongoose.Model<ITicket>) ??
      mongoose.model<ITicket>('Ticket', TicketSchema)
    );
  }

  private get mockOrderModel(): mongoose.Model<IMockOrder> {
    return (
      (mongoose.models.MockOrder as mongoose.Model<IMockOrder>) ??
      mongoose.model<IMockOrder>('MockOrder', MockOrderSchema)
    );
  }

  private get sessionModel(): mongoose.Model<IEventSession> {
    return (
      (mongoose.models.EventSession as mongoose.Model<IEventSession>) ??
      mongoose.model<IEventSession>('EventSession', EventSessionSchema)
    );
  }

  private get customerModel(): mongoose.Model<ICustomer> {
    return (
      (mongoose.models.Customer as mongoose.Model<ICustomer>) ??
      mongoose.model<ICustomer>('Customer', CustomerSchema)
    );
  }

  /** Settings fall back to "enabled for everyone" when the event has none stored. */
  reviewSettingsOf(event: Pick<IEvent, 'reviews'>): IEventReviewSettings {
    return {
      enabled: event.reviews?.enabled ?? DEFAULT_REVIEW_SETTINGS.enabled,
      audience: event.reviews?.audience ?? DEFAULT_REVIEW_SETTINGS.audience,
      allowBeforeEvent:
        event.reviews?.allowBeforeEvent ?? DEFAULT_REVIEW_SETTINGS.allowBeforeEvent,
    };
  }

  /** Rating aggregates per event, computed over approved reviews only. */
  async ratingsForEvents(eventIds: number[]): Promise<Map<number, ReviewRatingAggregate>> {
    const map = new Map<number, ReviewRatingAggregate>();
    if (!eventIds.length) return map;
    const rows = await this.reviewModel.aggregate<{
      _id: number;
      count: number;
      sum: number;
      ratings: number[];
    }>([
      { $match: { eventId: { $in: eventIds }, status: 'approved' } },
      {
        $group: {
          _id: '$eventId',
          count: { $sum: 1 },
          sum: { $sum: '$rating' },
          ratings: { $push: '$rating' },
        },
      },
    ]);
    for (const row of rows) {
      const histogram = [0, 0, 0, 0, 0];
      for (const rating of row.ratings) {
        const index = Math.min(Math.max(Math.round(rating), 1), 5) - 1;
        histogram[index] += 1;
      }
      map.set(row._id, {
        ratingAvg: row.count ? Math.round((row.sum / row.count) * 10) / 10 : 0,
        ratingCount: row.count,
        histogram,
      });
    }
    return map;
  }

  async ratingForEvent(eventId: number): Promise<ReviewRatingAggregate> {
    const map = await this.ratingsForEvents([eventId]);
    return map.get(eventId) ?? { ratingAvg: 0, ratingCount: 0, histogram: [0, 0, 0, 0, 0] };
  }

  /**
   * Rating as the given customer should see it: the public (approved-only) figure
   * plus their own review while it is still pending, so posting a review feels
   * immediate. A rejected review never counts, not even for its author.
   */
  private async ratingForCustomerView(
    eventId: number,
    customerId?: number,
  ): Promise<ReviewRatingAggregate> {
    const base = await this.ratingForEvent(eventId);
    if (customerId == null) return base;

    const own = await this.reviewModel
      .findOne({ eventId, customer: customerId, status: 'pending' })
      .select({ rating: 1 })
      .lean()
      .exec();
    if (!own) return base;

    const histogram = [...base.histogram];
    const index = Math.min(Math.max(Math.round(own.rating), 1), 5) - 1;
    histogram[index] += 1;
    const ratingCount = base.ratingCount + 1;
    const sum = base.ratingAvg * base.ratingCount + own.rating;
    return {
      ratingAvg: Math.round((sum / ratingCount) * 10) / 10,
      ratingCount,
      histogram,
    };
  }

  /** Has this customer actually paid for a ticket to the event? */
  private async hasPurchased(eventId: number, customerId: number): Promise<boolean> {
    const [ticket, paidOrder] = await Promise.all([
      this.ticketModel.exists({ eventId, customer: customerId }),
      this.mockOrderModel.exists({ event: eventId, customer: customerId, status: 'paid' }),
    ]);
    return Boolean(ticket || paidOrder);
  }

  /**
   * Reviews only make sense for regular events: a one-off runs once and disappears,
   * so there is nothing for a rating to describe over time.
   */
  private isReviewable(event: Pick<IEvent, 'recurrence'>): boolean {
    return event.recurrence?.enabled === true;
  }

  /**
   * True once the event has actually been performed — you may only review a show you
   * could have attended. For a regular event that means at least one session has
   * already ended.
   */
  private async hasRun(eventId: number): Promise<boolean> {
    // Sessions store local Thailand wall-clock time, so compare against "now in ICT"
    // rather than UTC — otherwise the cutoff is 7 hours out.
    const nowIct = new Date(Date.now() + ICT_OFFSET_MS);
    const today = nowIct.toISOString().slice(0, 10);
    const clock = nowIct.toISOString().slice(11, 16);
    const finished = await this.sessionModel.exists({
      eventId,
      // A cancelled show was never performed, so it cannot open reviews.
      status: { $ne: 'cancelled' },
      $or: [{ date: { $lt: today } }, { date: today, end: { $lte: clock } }],
    });
    return Boolean(finished);
  }

  /**
   * Public review list for an event: approved reviews for everyone, plus the
   * requesting customer's own review even while it is still pending. An event hidden
   * from the site has no public reviews page (404, like its event page).
   */
  async listPublic(
    eventId: number,
    customerId?: number,
  ): Promise<{
    reviews: PublicReview[];
    aggregate: ReviewRatingAggregate;
    settings: IEventReviewSettings;
    canReview: boolean;
    hasOwnReview: boolean;
    /** False until at least one session has finished — reviews open only afterwards. */
    eventHasRun: boolean;
  }> {
    const event = (await this.eventModel
      .findOne({ id: eventId, ...VISIBLE_ON_SITE_FILTER })
      .select({ id: 1, reviews: 1, recurrence: 1 })
      .lean()
      .exec()) as Pick<IEvent, 'id' | 'reviews' | 'recurrence'> | null;
    if (!event) {
      throw new NotFoundException('Event not found');
    }
    // One-off events have no reviews at all — report them as switched off so the
    // client hides the whole block rather than showing an empty state.
    const reviewable = this.isReviewable(event);
    const settings = reviewable
      ? this.reviewSettingsOf(event)
      : {
          enabled: false,
          audience: DEFAULT_REVIEW_SETTINGS.audience,
          allowBeforeEvent: DEFAULT_REVIEW_SETTINGS.allowBeforeEvent,
        };

    // Authors always see their own review — pending or rejected — so it never looks
    // like it vanished. Everyone else only ever sees approved ones.
    const statusFilter: mongoose.FilterQuery<IReview> =
      customerId != null
        ? { $or: [{ status: 'approved' }, { customer: customerId }] }
        : { status: 'approved' };

    const [rows, aggregate] = await Promise.all([
      this.reviewModel
        .find({ eventId, ...statusFilter })
        .sort({ created: -1 })
        .lean()
        .exec(),
      this.ratingForCustomerView(eventId, customerId),
    ]);

    const reviews = (rows as unknown as IReview[]).map(
      (review): PublicReview => ({
        id: review.id,
        rating: review.rating,
        message: review.message,
        authorName: review.authorName,
        created: review.created,
        status: review.status,
        photos: review.photos ?? [],
        isOwn: customerId != null && review.customer === customerId,
      }),
    );

    const hasOwnReview = reviews.some((review) => review.isOwn);
    let canReview = settings.enabled && customerId != null && !hasOwnReview;
    if (canReview && settings.audience === 'buyers') {
      canReview = await this.hasPurchased(eventId, customerId as number);
    }
    /*
     * Normally you may only review a show you could have attended. Admins can waive
     * that per event (`allowBeforeEvent`), e.g. for previews or an ongoing season.
     * `eventHasRun` still reports the real state so the client can word its notice.
     */
    const eventHasRun = reviewable ? await this.hasRun(eventId) : false;
    if (canReview && !eventHasRun && !settings.allowBeforeEvent) canReview = false;

    return { reviews, aggregate, settings, canReview, hasOwnReview, eventHasRun };
  }

  /**
   * Newest approved reviews of ACTIVE recurring events, for the public
   * "guest reviews" carousel on the regular-events listing. Reviews whose event is
   * gone, deactivated or hidden from the site are skipped so no card ever links nowhere.
   */
  async listLatestPublic(limit: number): Promise<
    Array<{
      id: number;
      rating: number;
      message: string;
      authorName: string;
      created: Date;
      photos: number[];
      eventId: number;
      eventTitle: ILocalizedText;
    }>
  > {
    const capped = Math.min(Math.max(limit, 1), 50);
    // Over-fetch: some reviews drop out when their event's filters apply.
    const rows = (await this.reviewModel
      .find({ status: 'approved' })
      .sort({ created: -1 })
      .limit(capped * 4)
      .lean()
      .exec()) as unknown as IReview[];
    if (!rows.length) return [];

    const eventIds = [...new Set(rows.map((r) => r.eventId))];
    const events = (await this.eventModel
      .find({
        id: { $in: eventIds },
        status: 'ACTIVE',
        'recurrence.enabled': true,
        ...VISIBLE_ON_SITE_FILTER,
      })
      .select({ id: 1, title: 1 })
      .lean()
      .exec()) as Array<Pick<IEvent, 'id' | 'title'>>;
    const eventById = new Map(events.map((e) => [e.id, e]));

    const result: Array<{
      id: number;
      rating: number;
      message: string;
      authorName: string;
      created: Date;
      photos: number[];
      eventId: number;
      eventTitle: ILocalizedText;
    }> = [];
    for (const review of rows) {
      const event = eventById.get(review.eventId);
      if (!event) continue;
      result.push({
        id: review.id,
        rating: review.rating,
        message: review.message,
        authorName: review.authorName,
        created: review.created,
        photos: review.photos ?? [],
        eventId: event.id,
        eventTitle: event.title,
      });
      if (result.length >= capped) break;
    }
    return result;
  }

  /** Creates a `pending` review; it then waits for a moderator in lotus-admin. */
  async create(dto: CreateReviewDto, customerId: number): Promise<PublicReview> {
    const event = (await this.eventModel
      .findOne({ id: dto.eventId })
      .select({ id: 1, title: 1, reviews: 1, recurrence: 1 })
      .lean()
      .exec()) as Pick<IEvent, 'id' | 'title' | 'reviews' | 'recurrence'> | null;
    if (!event) {
      throw new NotFoundException('Event not found');
    }
    if (!this.isReviewable(event)) {
      throw new ForbiddenException('Only regular events can be reviewed');
    }

    const settings = this.reviewSettingsOf(event);
    if (!settings.enabled) {
      throw new ForbiddenException('Reviews are disabled for this event');
    }
    // Admins can waive the "must have happened" rule per event.
    if (!settings.allowBeforeEvent && !(await this.hasRun(dto.eventId))) {
      throw new ForbiddenException('This event has not taken place yet');
    }
    if (settings.audience === 'buyers' && !(await this.hasPurchased(dto.eventId, customerId))) {
      throw new ForbiddenException('Only customers who bought a ticket can review this event');
    }

    const existing = await this.reviewModel.findOne({ eventId: dto.eventId, customer: customerId });
    if (existing) {
      throw new BadRequestException('You have already reviewed this event');
    }

    const customer = await this.customerModel.findOne({ id: customerId }).lean().exec();
    const authorName = (customer?.fullname || '').trim() || 'Guest';

    /*
      Photos are stored as Media rows (same path event covers take) and the
      review keeps only their ids. Stored before the review so a bad image fails
      the request without leaving a half-written review behind; if the review
      insert then fails, the orphaned media is cleaned up below.
    */
    const photoIds: number[] = [];
    for (const dataUrl of dto.photos ?? []) {
      try {
        photoIds.push(await this.mediaService.createFromDataUrl(dataUrl, customerId));
      } catch (error) {
        await Promise.all(photoIds.map((id) => this.mediaService.removeById(id)));
        throw new BadRequestException(
          `Could not store a review photo: ${(error as Error)?.message ?? 'invalid image'}`,
        );
      }
    }

    let created: IReview;
    try {
      created = await this.reviewModel.create({
        eventId: dto.eventId,
        customer: customerId,
        authorName,
        rating: dto.rating,
        message: dto.message.trim(),
        ...(photoIds.length ? { photos: photoIds } : {}),
        status: 'pending',
        created: new Date(),
      });
    } catch (error) {
      await Promise.all(photoIds.map((id) => this.mediaService.removeById(id)));
      throw error;
    }

    /*
      Moderation happens in lotus-admin only. The Telegram approve/reject flow
      (`ReviewsTelegramService`) is kept wired but intentionally not triggered here:
      the moderation chat should not receive a message per review.
    */
    // The event's own group chat (LINE) does get one, awaiting moderation.
    void this.messengersNotifier.notifyReviewCreated(created.id).catch((error) => {
      this.logger.warn(
        `Messenger review notification failed for review ${created.id}: ${(error as Error)?.message}`,
      );
    });

    return {
      id: created.id,
      rating: created.rating,
      message: created.message,
      authorName: created.authorName,
      created: created.created,
      status: created.status,
      photos: created.photos ?? [],
      isOwn: true,
    };
  }

  // ---- moderation ----

  async listForModeration(status?: string, eventId?: number) {
    const filter: mongoose.FilterQuery<IReview> = {};
    if (status && ['pending', 'approved', 'rejected'].includes(status)) {
      filter.status = status as ReviewStatus;
    }
    if (Number.isInteger(eventId)) filter.eventId = eventId;

    const reviews = (await this.reviewModel
      .find(filter)
      .sort({ created: -1 })
      .limit(500)
      .lean()
      .exec()) as unknown as IReview[];

    const eventIds = Array.from(new Set(reviews.map((review) => review.eventId)));
    const events = (await this.eventModel
      .find({ id: { $in: eventIds } })
      .select({ id: 1, title: 1 })
      .lean()
      .exec()) as Array<Pick<IEvent, 'id' | 'title'>>;
    const titleById = new Map(events.map((event) => [event.id, event.title]));

    return reviews.map((review) => ({
      id: review.id,
      eventId: review.eventId,
      eventTitle: titleById.get(review.eventId) ?? { th: '', en: '', ru: '' },
      customer: review.customer,
      authorName: review.authorName,
      rating: review.rating,
      message: review.message,
      photos: review.photos ?? [],
      status: review.status,
      rejectReason: review.rejectReason ?? null,
      moderatedAt: review.moderatedAt ?? null,
      moderatedBy: review.moderatedBy ?? null,
      created: review.created,
    }));
  }

  /**
   * Events that have at least one review, each with its moderation counters.
   * Drives the event-first layout of the admin moderation screen.
   */
  async listEventsWithReviewStats() {
    const rows = await this.reviewModel.aggregate<{
      _id: number;
      total: number;
      pending: number;
      approved: number;
      rejected: number;
      lastCreated: Date;
      ratingSum: number;
    }>([
      {
        $group: {
          _id: '$eventId',
          total: { $sum: 1 },
          pending: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] } },
          approved: { $sum: { $cond: [{ $eq: ['$status', 'approved'] }, 1, 0] } },
          rejected: { $sum: { $cond: [{ $eq: ['$status', 'rejected'] }, 1, 0] } },
          ratingSum: { $sum: { $cond: [{ $eq: ['$status', 'approved'] }, '$rating', 0] } },
          lastCreated: { $max: '$created' },
        },
      },
      { $sort: { pending: -1, lastCreated: -1 } },
    ]);

    const events = (await this.eventModel
      .find({ id: { $in: rows.map((row) => row._id) } })
      .select({ id: 1, title: 1, reviews: 1 })
      .lean()
      .exec()) as Array<Pick<IEvent, 'id' | 'title' | 'reviews'>>;
    const eventById = new Map(events.map((event) => [event.id, event]));

    return rows.map((row) => {
      const event = eventById.get(row._id);
      return {
        eventId: row._id,
        eventTitle: event?.title ?? { th: '', en: '', ru: '' },
        settings: event ? this.reviewSettingsOf(event) : DEFAULT_REVIEW_SETTINGS,
        total: row.total,
        pending: row.pending,
        approved: row.approved,
        rejected: row.rejected,
        ratingAvg: row.approved ? Math.round((row.ratingSum / row.approved) * 10) / 10 : 0,
        lastCreated: row.lastCreated,
      };
    });
  }

  /** Admin-only correction of a review's text or star rating. */
  async updateReview(
    reviewId: number,
    changes: { rating?: number; message?: string },
  ): Promise<IReview> {
    const update: Record<string, unknown> = {};
    if (typeof changes.rating === 'number') update.rating = changes.rating;
    if (typeof changes.message === 'string') update.message = changes.message.trim();
    if (!Object.keys(update).length) {
      throw new BadRequestException('Nothing to update');
    }
    const updated = await this.reviewModel
      .findOneAndUpdate({ id: reviewId }, { $set: update }, { new: true })
      .lean()
      .exec();
    if (!updated) {
      throw new NotFoundException('Review not found');
    }
    return updated as unknown as IReview;
  }

  async deleteReview(reviewId: number): Promise<{ ok: true }> {
    const existing = (await this.reviewModel
      .findOne({ id: reviewId })
      .select({ photos: 1 })
      .lean()
      .exec()) as Pick<IReview, 'photos'> | null;
    const result = await this.reviewModel.deleteOne({ id: reviewId }).exec();
    if (!result.deletedCount) {
      throw new NotFoundException('Review not found');
    }
    // Photos belong to the review alone — drop them with it.
    await Promise.all((existing?.photos ?? []).map((id) => this.mediaService.removeById(id)));
    this.logger.log(`Review ${reviewId} deleted`);
    return { ok: true };
  }

  async setStatus(
    reviewId: number,
    status: Exclude<ReviewStatus, 'pending'>,
    moderatedBy: string,
    rejectReason?: string,
  ): Promise<IReview> {
    const now = new Date();
    const update: mongoose.UpdateQuery<IReview> = {
      $set: { status, moderatedAt: now, moderatedBy },
    };
    if (status === 'rejected') {
      update.$set = { ...update.$set, rejectReason: rejectReason?.trim() || '' };
    } else {
      // Stamping the approval is what later keeps this review out of the queue
      // when its event is sent back to moderation.
      update.$set = { ...update.$set, approvedAt: now };
      update.$unset = { rejectReason: 1 };
    }
    const updated = await this.reviewModel
      .findOneAndUpdate({ id: reviewId }, update, { new: true })
      .lean()
      .exec();
    if (!updated) {
      throw new NotFoundException('Review not found');
    }
    this.logger.log(`Review ${reviewId} -> ${status} by ${moderatedBy}`);
    return updated as unknown as IReview;
  }

  /** Admin toggle for per-event review settings. */
  async updateEventReviewSettings(
    eventId: number,
    settings: Partial<IEventReviewSettings>,
  ): Promise<IEventReviewSettings> {
    const event = (await this.eventModel
      .findOne({ id: eventId })
      .select({ reviews: 1 })
      .lean()
      .exec()) as Pick<IEvent, 'reviews'> | null;
    if (!event) {
      throw new NotFoundException('Event not found');
    }
    const next: IEventReviewSettings = {
      ...this.reviewSettingsOf(event),
      ...settings,
    };
    await this.eventModel.updateOne({ id: eventId }, { $set: { reviews: next } }).exec();
    return next;
  }

  async findById(reviewId: number): Promise<IReview | null> {
    return this.reviewModel.findOne({ id: reviewId }).lean().exec() as Promise<IReview | null>;
  }
}
