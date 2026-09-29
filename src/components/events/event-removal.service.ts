import {
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import mongoose from 'mongoose';
import { EventSchema, IEvent, ILocalizedText } from './schemas/event.schema';
import type { EventStatus } from './constants/event-status.constant';
import {
  EVENT_DELETE_ARCHIVE_FAILED_ERROR,
  EVENT_DELETE_RECHECK_FAILED_ERROR,
  EVENT_DELETE_ROLLBACK_FAILED_ERROR,
  EVENT_DELETE_ROLLED_BACK_ERROR,
  EVENT_REMOVAL_OUTCOME_CHANGED_ERROR,
  EVENT_SALE_ORDER_STATUSES,
  eventRemovalArchiveReasons,
  type EventRemovalArchiveReason,
  type EventRemovalCounts,
  type EventRemovalWarning,
} from './constants/event-removal.constant';
import { nowIctClock, todayIct } from './utils/ict-date.util';
import { ITicket, TicketSchema } from '../tickets/schemas/ticket.schema';
import { IMockOrder, MockOrderSchema } from '../mock-orders/schemas/mock-order.schema';
import {
  EventSessionSchema,
  IEventSession,
} from '../event-sessions/schemas/event-session.schema';
import { EventSessionsService } from '../event-sessions/event-sessions.service';
import { IManager, ManagerSchema } from '../managers/schemas/manager.schema';
import { BannerSchema, IBanner } from '../banners/schemas/banner.schema';
import {
  DeletedEventSchema,
  IDeletedEvent,
  type DeletedEventState,
} from '../admin/schemas/deleted-event.schema';
import { IndexNowService } from '../../services/indexnow/indexnow.service';
import { EventMessengersNotifierService } from '../event-messengers/services/event-messengers-notifier.service';
import { SALES_REASON } from '../event-messengers/constants/event-messengers.constants';
import { countEventPayouts } from '../finance/finance-event-links';
import { countEventArbiPayStores } from '../arbipay-stores/arbipay-store-event-links';
import { cleanUpDeletedEventLinks, softDeleteEvent } from './event-soft-delete';

/** Who acts: the organizer, or their Admin manager on the organizer's behalf. */
export type EventRemovalActor = { userId: string; managerId?: string };

/** Response of `GET /events/:id/removal-check`. */
export type EventRemovalCheck = {
  id: number;
  title: ILocalizedText;
  status: EventStatus;
  isRecurring: boolean;
  /** Already in the organizer archive. */
  archived: boolean;
  /** What `POST /events/:id/remove` does right now. */
  outcome: 'delete' | 'archive';
  /** Why it archives (empty for `delete`). */
  reasons: EventRemovalArchiveReason[];
  /** Banner and ARBI Pay store counts stay server-side: the organizer manages neither. */
  counts: Omit<EventRemovalCounts, 'activeBanners' | 'arbipayStores'>;
  warnings: EventRemovalWarning[];
};

/** Response of `POST /events/:id/remove` and `DELETE /events/:id`. */
export type EventRemovalResult =
  | { outcome: 'deleted' }
  | { outcome: 'archived'; archivedAt: Date | null };

/** Response of `POST /events/:id/restore`. */
export type EventRestoreResult = { id: number; archived: false; status: EventStatus };

/** Statuses whose event page is public (same rule as the IndexNow pings in EventsService). */
const PUBLIC_EVENT_STATUSES: readonly EventStatus[] = ['ACTIVE', 'COMPLETED', 'CANCELLED'];
/** Orders are saved right after reading the event; wait this long so one already in flight lands before the re-check. */
const DELETE_RACE_GRACE_MS = 2000;

/**
 * Organizer "delete event": deletes an event without sales, archives one with sales.
 * The delete mirrors `AdminEventsService.deleteEvent` (snapshot first, re-check after a
 * grace period, rollback on a late sale) without the typed phrase; media is kept so the
 * `deletedevents` snapshot stays restorable. See `constants/event-removal.constant.ts`.
 */
@Injectable()
export class EventRemovalService {
  private readonly logger = new Logger(EventRemovalService.name);

  constructor(
    private readonly eventSessionsService: EventSessionsService,
    private readonly indexNowService: IndexNowService,
    private readonly messengersNotifier: EventMessengersNotifierService,
  ) {}

  private get eventModel(): mongoose.Model<IEvent> {
    return (mongoose.models.Event as mongoose.Model<IEvent>) ?? mongoose.model<IEvent>('Event', EventSchema);
  }

  private get ticketModel(): mongoose.Model<ITicket> {
    return (mongoose.models.Ticket as mongoose.Model<ITicket>) ??
      mongoose.model<ITicket>('Ticket', TicketSchema);
  }

  private get mockOrderModel(): mongoose.Model<IMockOrder> {
    return (mongoose.models.MockOrder as mongoose.Model<IMockOrder>) ??
      mongoose.model<IMockOrder>('MockOrder', MockOrderSchema);
  }

  private get sessionModel(): mongoose.Model<IEventSession> {
    return (mongoose.models.EventSession as mongoose.Model<IEventSession>) ??
      mongoose.model<IEventSession>('EventSession', EventSessionSchema);
  }

  private get managerModel(): mongoose.Model<IManager> {
    return (mongoose.models.Manager as mongoose.Model<IManager>) ??
      mongoose.model<IManager>('Manager', ManagerSchema);
  }

  private get bannerModel(): mongoose.Model<IBanner> {
    return (mongoose.models.Banner as mongoose.Model<IBanner>) ??
      mongoose.model<IBanner>('Banner', BannerSchema);
  }

  private get deletedEventModel(): mongoose.Model<IDeletedEvent> {
    return (mongoose.models.DeletedEvent as mongoose.Model<IDeletedEvent>) ??
      mongoose.model<IDeletedEvent>('DeletedEvent', DeletedEventSchema);
  }

  /** Event group chat (LINE): sales closed/opened by the archive flag. Fire-and-forget. */
  private recheckMessengerSales(eventId: number, reason: string): void {
    void this.messengersNotifier.recheckSales(eventId, reason).catch((err) => {
      this.logger.warn(`Messenger sales recheck failed for event ${eventId}: ${(err as Error)?.message}`);
    });
  }

  private actorLabel(actor: EventRemovalActor): string {
    return actor.managerId ? `manager:${actor.managerId}` : `user:${actor.userId}`;
  }

  private isPublicPage(event: Pick<IEvent, 'status' | 'hiddenFromSite'>): boolean {
    return PUBLIC_EVENT_STATUSES.includes(event.status) && event.hiddenFromSite !== true;
  }

  /** Raw lean event of the organizer: 404 when unknown, 403 when someone else's. */
  private async loadOwned(eventId: number, userId: string): Promise<IEvent> {
    if (!Number.isSafeInteger(eventId)) {
      throw new NotFoundException('Event not found');
    }
    // No ensureEventMediaIds: the snapshot keeps the stored document exactly as it is.
    const event = (await this.eventModel.findOne({ id: eventId }).lean().exec()) as IEvent | null;
    // A soft-deleted event is gone for the organizer (only the admin panel still lists it).
    if (!event || event.softDeleted === true) {
      throw new NotFoundException('Event not found');
    }
    if (event.creator !== Number(userId)) {
      throw new ForbiddenException('You can only manage your own events');
    }
    return event;
  }

  private async collectCounts(event: IEvent): Promise<EventRemovalCounts> {
    const id = event.id;
    // `id` is a stored integer, so the pattern needs no escaping.
    const bannerHref = new RegExp(`/events/${id}(?:[-/?#]|$)`);
    const [tickets, activeTickets, orderRows, activeBanners, upcomingShowsWithSales, payouts, arbipayStores] =
      await Promise.all([
        this.ticketModel.countDocuments({ eventId: id }).exec(),
        this.ticketModel.countDocuments({ eventId: id, status: 'ACTIVE' }).exec(),
        this.mockOrderModel
          .aggregate<{ _id: string; count: number }>([
            { $match: { event: id, status: { $in: [...EVENT_SALE_ORDER_STATUSES] } } },
            { $group: { _id: '$status', count: { $sum: 1 } } },
          ])
          .exec(),
        this.bannerModel.countDocuments({ isActive: true, href: bannerHref }).exec(),
        this.countUpcomingShowsWithSales(event),
        countEventPayouts(id),
        countEventArbiPayStores(id),
      ]);
    const orders = new Map(orderRows.map((row) => [row._id, row.count]));
    return {
      tickets,
      activeTickets,
      paidOrders: orders.get('paid') ?? 0,
      pendingCashOrders: orders.get('pending_cash') ?? 0,
      waitOrders: orders.get('wait') ?? 0,
      refundedOrders: orders.get('refunded') ?? 0,
      upcomingShowsWithSales,
      payouts,
      activeBanners,
      arbipayStores,
    };
  }

  /** Recurring events: shows not cancelled and not started yet (ICT) that have sold tickets. */
  private async countUpcomingShowsWithSales(event: IEvent): Promise<number> {
    if (event.recurrence?.enabled !== true) {
      return 0;
    }
    const { sessions } = await this.eventSessionsService.getSalesSummary(event.id);
    // Session dates and times are ICT wall-clock strings, so compare them as such.
    const nowIct = `${todayIct()} ${nowIctClock()}`;
    return sessions.filter(
      (session) => session.status !== 'cancelled' && `${session.date} ${session.start}` > nowIct,
    ).length;
  }

  private buildCheck(event: IEvent, counts: EventRemovalCounts): EventRemovalCheck {
    const reasons = eventRemovalArchiveReasons(counts);
    const archived = event.archivedByOrganizer === true;
    const warnings: EventRemovalWarning[] = [];
    if (!archived && this.isPublicPage(event)) {
      warnings.push('event_is_public');
    }
    if (counts.activeTickets > 0) {
      warnings.push('valid_tickets_remain');
    }
    if (counts.upcomingShowsWithSales > 0) {
      warnings.push('upcoming_shows_with_sales');
    }
    return {
      id: event.id,
      title: event.title,
      status: event.status,
      isRecurring: event.recurrence?.enabled === true,
      archived,
      outcome: reasons.length ? 'archive' : 'delete',
      reasons,
      counts: {
        tickets: counts.tickets,
        activeTickets: counts.activeTickets,
        paidOrders: counts.paidOrders,
        pendingCashOrders: counts.pendingCashOrders,
        waitOrders: counts.waitOrders,
        refundedOrders: counts.refundedOrders,
        upcomingShowsWithSales: counts.upcomingShowsWithSales,
        payouts: counts.payouts,
      },
      warnings,
    };
  }

  /** Preflight for the organizer dialog; `remove` recomputes everything itself. */
  async getRemovalCheck(eventId: number, userId: string): Promise<EventRemovalCheck> {
    const event = await this.loadOwned(eventId, userId);
    return this.buildCheck(event, await this.collectCounts(event));
  }

  /**
   * Deletes an event without sales, archives an event with sales. `expect` is the outcome
   * the dialog showed: a different one now is a 409 and nothing is written. Without
   * `expect` (plain `DELETE /events/:id`) the server-side outcome is applied as is.
   */
  async remove(
    eventId: number,
    actor: EventRemovalActor,
    expect?: 'delete' | 'archive',
  ): Promise<EventRemovalResult> {
    const event = await this.loadOwned(eventId, actor.userId);
    const counts = await this.collectCounts(event);
    const check = this.buildCheck(event, counts);
    if (expect && expect !== check.outcome) {
      this.logger.warn(
        `Event ${eventId} removal refused: expected ${expect}, now ${check.outcome} (${this.actorLabel(actor)})`,
      );
      throw new ConflictException({
        statusCode: 409,
        message: EVENT_REMOVAL_OUTCOME_CHANGED_ERROR,
        error: 'Conflict',
      });
    }
    if (check.outcome === 'archive') {
      return this.archive(event, actor, check.reasons);
    }
    // With an ARBI Pay store the event stays in the database (soft delete): same answer for the organizer.
    return counts.arbipayStores > 0 ? this.softDelete(event, actor) : this.deleteWithoutSales(event, counts, actor);
  }

  private async softDelete(event: IEvent, actor: EventRemovalActor): Promise<EventRemovalResult> {
    const by = this.actorLabel(actor);
    const outcome = await softDeleteEvent(event, by, this.logger);
    if (outcome.changed) {
      this.logger.log(
        `Event ${event.id} soft-deleted (ARBI Pay store) by ${by}; managersDetached=${outcome.managersDetached}; cleanupErrors=${outcome.errors.length}`,
      );
      if (this.isPublicPage(event)) {
        this.indexNowService.notifyPaths([this.indexNowService.eventPath(event.id, event.title?.en), '/events']);
      }
    }
    return { outcome: 'deleted' };
  }

  private async archive(
    event: IEvent,
    actor: EventRemovalActor,
    reasons: EventRemovalArchiveReason[],
  ): Promise<EventRemovalResult> {
    if (event.archivedByOrganizer === true) {
      return { outcome: 'archived', archivedAt: event.archivedByOrganizerAt ?? null };
    }
    const by = this.actorLabel(actor);
    const archivedAt = new Date();
    // `timestamps: false`: not an edit of the event, so `updatedAt` stays put too.
    const { matchedCount } = await this.eventModel
      .updateOne(
        { id: event.id, archivedByOrganizer: { $ne: true } },
        { $set: { archivedByOrganizer: true, archivedByOrganizerAt: archivedAt, archivedByOrganizerBy: by } },
        { timestamps: false },
      )
      .exec();
    if (matchedCount === 0) {
      // Archived meanwhile (another tab) — or deleted.
      const now = (await this.eventModel
        .findOne({ id: event.id })
        .select({ archivedByOrganizerAt: 1 })
        .lean()
        .exec()) as Pick<IEvent, 'archivedByOrganizerAt'> | null;
      if (!now) {
        throw new NotFoundException('Event not found');
      }
      return { outcome: 'archived', archivedAt: now.archivedByOrganizerAt ?? null };
    }
    this.logger.log(`Event ${event.id} archived by ${by} (${reasons.join(',')})`);
    this.recheckMessengerSales(event.id, SALES_REASON.ARCHIVED_BY_ORGANIZER);
    // Same re-crawl ping as hiding: the public page just disappeared.
    if (this.isPublicPage(event)) {
      this.indexNowService.notifyPaths([
        this.indexNowService.eventPath(event.id, event.title?.en),
        '/events',
      ]);
    }
    return { outcome: 'archived', archivedAt };
  }

  /** Best effort: the archive state is audit data and must never fail the request. */
  private async updateDeletedEventArchive(
    archiveId: unknown,
    set: Partial<Pick<IDeletedEvent, 'event' | 'sessions' | 'cleanupErrors'>> & {
      state: DeletedEventState;
    },
  ): Promise<void> {
    try {
      await this.deletedEventModel.updateOne({ _id: archiveId }, { $set: set }).exec();
    } catch (err) {
      this.logger.error(
        `Could not set deletedevents ${String(archiveId)} state=${set.state}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Hard delete of an event without sales: snapshot first, rollback if a sale lands
   * meanwhile or the re-check itself fails. Media, reviews, favorites, failed/expired/
   * cancelled orders, promo codes and inactive banners are left untouched.
   */
  private async deleteWithoutSales(
    event: IEvent,
    counts: EventRemovalCounts,
    actor: EventRemovalActor,
  ): Promise<EventRemovalResult> {
    const id = event.id;
    const by = this.actorLabel(actor);

    // Archive before deleting: if it cannot be written, nothing is deleted.
    let archive: IDeletedEvent;
    let sessions: Record<string, unknown>[];
    try {
      const [sessionRows, managerRows] = await Promise.all([
        this.sessionModel.find({ eventId: id }).lean().exec(),
        this.managerModel
          .find({ $or: [{ events: id }, { event: id }] })
          .select({ id: 1, type: 1, allEvents: 1, events: 1, event: 1, createdByUserId: 1 })
          .lean()
          .exec(),
      ]);
      sessions = sessionRows;
      archive = await this.deletedEventModel.create({
        eventId: id,
        eventStatus: event.status,
        creator: event.creator,
        title: event.title,
        event,
        sessions,
        managers: managerRows,
        counts,
        source: 'organizer',
        deletedBy: by,
        deletedByAdminId: null,
        deletedByAdminEmail: '',
        deletedAt: new Date(),
        state: 'archived',
      });
    } catch (err) {
      this.logger.error(
        `Event ${id} delete aborted: archive write failed (${by}): ${(err as Error).message}`,
      );
      throw new InternalServerErrorException(EVENT_DELETE_ARCHIVE_FAILED_ERROR);
    }

    const deleted = await this.eventModel.findOneAndDelete({ id }).lean().exec();
    if (!deleted) {
      await this.updateDeletedEventArchive(archive._id, { state: 'aborted' });
      throw new NotFoundException('Event not found');
    }

    // An order that read the event just before the delete is saved within milliseconds:
    // wait for it, and put the event back if one appeared (sessions/managers are untouched so far).
    // A re-check that cannot run counts as unsafe: fail closed and restore the event too.
    let late: { orders: number; tickets: number } | null = null;
    try {
      await new Promise((resolve) => setTimeout(resolve, DELETE_RACE_GRACE_MS));
      const [orders, tickets] = await Promise.all([
        this.mockOrderModel
          .countDocuments({ event: id, status: { $in: [...EVENT_SALE_ORDER_STATUSES] } })
          .exec(),
        this.ticketModel.countDocuments({ eventId: id }).exec(),
      ]);
      late = { orders, tickets };
    } catch (err) {
      this.logger.error(
        `Event ${id} delete re-check failed, restoring the event (${by}, archive=${String(archive._id)}): ${(err as Error).message}`,
      );
    }
    if (!late || late.orders + late.tickets > 0) {
      try {
        // Raw driver insert keeps the original _id, id and timestamps; no plugin runs.
        await this.eventModel.collection.insertOne(deleted as mongoose.AnyObject);
      } catch (err) {
        await this.updateDeletedEventArchive(archive._id, { state: 'rollback_failed' });
        this.logger.error(
          `CRITICAL: event ${id} deleted but could not be restored (${late ? 'late orders' : 're-check failed'}); restore from deletedevents ${String(archive._id)}: ${(err as Error).message}`,
        );
        throw new InternalServerErrorException(EVENT_DELETE_ROLLBACK_FAILED_ERROR);
      }
      await this.updateDeletedEventArchive(archive._id, { state: 'rolled_back' });
      if (!late) {
        this.logger.warn(
          `Event ${id} delete rolled back: re-check failed (${by}, archive=${String(archive._id)})`,
        );
        throw new InternalServerErrorException(EVENT_DELETE_RECHECK_FAILED_ERROR);
      }
      this.logger.warn(
        `Event ${id} delete rolled back: ${late.orders} order(s)/${late.tickets} ticket(s) appeared (${by}, archive=${String(archive._id)})`,
      );
      throw new ConflictException({
        statusCode: 409,
        message: EVENT_DELETE_ROLLED_BACK_ERROR,
        error: 'Conflict',
      });
    }

    // The event is gone: cleanup below is best effort and never throws.
    const cleanupErrors: string[] = [];
    let finalSessions: Record<string, unknown>[] | undefined;
    let sessionsDeleted = 0;
    try {
      finalSessions = await this.sessionModel.find({ eventId: id }).lean().exec();
      ({ deletedCount: sessionsDeleted } = await this.sessionModel
        .deleteMany({ eventId: id })
        .exec());
    } catch (err) {
      cleanupErrors.push('sessions_cleanup_failed');
      this.logger.error(
        `Event ${id} deleted but its sessions were not (archive=${String(archive._id)}): ${(err as Error).message}`,
      );
    }
    const links = await cleanUpDeletedEventLinks(id, this.logger, `archive=${String(archive._id)}`);
    cleanupErrors.push(...links.errors);

    await this.updateDeletedEventArchive(archive._id, {
      state: 'deleted',
      event: deleted,
      sessions: finalSessions ?? sessions,
      cleanupErrors,
    });

    if (PUBLIC_EVENT_STATUSES.includes(deleted.status)) {
      this.indexNowService.notifyPaths([
        this.indexNowService.eventPath(id, deleted.title?.en),
        '/events',
      ]);
    }

    this.logger.log(
      `Event ${id} deleted by ${by}; archive=${String(archive._id)}; sessions=${sessionsDeleted}; managersDetached=${links.managersDetached}; cleanupErrors=${cleanupErrors.length}`,
    );

    return { outcome: 'deleted' };
  }

  /**
   * Returns an archived event: the flag only — status, moderation and every other field
   * stay as they are (a published event is on the site and on sale again). Idempotent.
   */
  async restore(eventId: number, actor: EventRemovalActor): Promise<EventRestoreResult> {
    const event = await this.loadOwned(eventId, actor.userId);
    if (event.archivedByOrganizer !== true) {
      return { id: event.id, archived: false, status: event.status };
    }
    const by = this.actorLabel(actor);
    // `timestamps: false`: not an edit of the event, so `updatedAt` stays put too.
    const { matchedCount } = await this.eventModel
      .updateOne(
        { id: event.id, archivedByOrganizer: true },
        { $set: { archivedByOrganizer: false, archivedByOrganizerAt: new Date(), archivedByOrganizerBy: by } },
        { timestamps: false },
      )
      .exec();
    if (matchedCount === 0) {
      // Restored meanwhile (another tab) — or deleted.
      const now = (await this.eventModel
        .findOne({ id: event.id })
        .select({ status: 1 })
        .lean()
        .exec()) as Pick<IEvent, 'status'> | null;
      if (!now) {
        throw new NotFoundException('Event not found');
      }
      return { id: event.id, archived: false, status: now.status };
    }
    this.logger.log(`Event ${event.id} restored from the archive by ${by}`);
    this.recheckMessengerSales(event.id, SALES_REASON.RESTORED_BY_ORGANIZER);
    // The public page is back (unless the organizer hid the event separately).
    if (this.isPublicPage(event)) {
      this.indexNowService.notifyPaths([
        this.indexNowService.eventPath(event.id, event.title?.en),
        '/events',
      ]);
    }
    return { id: event.id, archived: false, status: event.status };
  }
}
