import {
  Injectable,
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import mongoose from "mongoose";
import { EventSchema, IEvent } from "../../events/schemas/event.schema";
import { ITicket, TicketSchema } from "../../tickets/schemas/ticket.schema";
import {
  EVENT_STATUSES,
  isSalesClosed,
  type EventStatus,
} from "../../events/constants/event-status.constant";
import { isHiddenFromSite } from "../../events/constants/event-visibility.constant";
import { EventMessengersNotifierService } from "../../event-messengers/services/event-messengers-notifier.service";
import { SALES_REASON } from "../../event-messengers/constants/event-messengers.constants";
import {
  IMockOrder,
  MockOrderSchema,
  MOCK_ORDER_STATUSES,
  type MockOrderStatus,
} from "../../mock-orders/schemas/mock-order.schema";
import {
  EventSessionSchema,
  IEventSession,
} from "../../event-sessions/schemas/event-session.schema";
import { IReview, ReviewSchema } from "../../reviews/schemas/review.schema";
import {
  FavoriteSchema,
  IFavorite,
} from "../../favorites/schemas/favorite.schema";
import { IManager, ManagerSchema } from "../../managers/schemas/manager.schema";
import {
  IPromoCode,
  PromoCodeSchema,
} from "../../promocodes/schemas/promo-code.schema";
import { BannerSchema, IBanner } from "../../banners/schemas/banner.schema";
import {
  CashierArbiSchema,
  ICashierArbi,
} from "../../cashier-arbi/schemas/cashier-arbi.schema";
import {
  CmsPageSchema,
  ICmsPage,
} from "../../content-cms/schemas/cms-page.schema";
import { isLocationRepeaterId } from "../../content-cms/constants/location-card.constants";
import { UsersService } from "../../users/users.service";
import { EventsService } from "../../events/events.service";
import { resolveEventFeePercents } from "../../events/utils/event-fee.util";
import { IndexNowService } from "../../../services/indexnow/indexnow.service";
import type { IUser } from "../../users/schemas/user.schema";
import { AdminEventsQueryDto } from "../dto/admin-events-query.dto";
import {
  DeletedEventSchema,
  IDeletedEvent,
  type DeletedEventState,
} from "../schemas/deleted-event.schema";
import { AdminsService } from "./admins.service";
import type {
  AdminEventCashPaymentState,
  AdminEventCashPaymentWarning,
  AdminEventDeleteResult,
  AdminEventDeletionBlocker,
  AdminEventDeletionCheck,
  AdminEventDeletionCounts,
  AdminEventDeletionWarning,
  AdminEventDetails,
  AdminEventListItem,
  AdminEventsListResult,
} from "../types/admin-event.types";
import type { ILocalizedText } from "../../events/schemas/event.schema";
import { venueLabel } from '../../events/utils/venue.util';
import { countEventPayouts } from "../../finance/finance-event-links";
import { countEventArbiPayStores } from "../../arbipay-stores/arbipay-store-event-links";
import { cleanUpDeletedEventLinks, softDeleteEvent } from "../../events/event-soft-delete";
import {
  APPROVED_EVENT_STATUSES,
  EventApprovalSnapshotsService,
} from "../../events/event-approval-snapshots.service";
import { EventSponsorsService } from "../../events/event-sponsors.service";
import { EVENT_SPONSOR_ERROR } from "../../events/constants/event-sponsors.constant";
import {
  buildEventModerationShape,
  diffEventModerationShapes,
  paymentOptionsSummary,
  sponsorLogoIds,
  sponsorsShape,
} from "../../events/utils/event-moderation-shape.util";
import { ADMIN_EVENT_ERROR } from "../constants/admin-event.constant";
import {
  toUpdateQuery,
  updateEventGuarded,
} from "../utils/admin-event-guarded-update.util";

/** Orders that carry money or can still turn into tickets — deleting their event would orphan them. */
const DELETE_BLOCKING_ORDER_STATUSES: readonly MockOrderStatus[] = [
  "wait",
  "pending_cash",
  "paid",
  "refunded",
];
/** Statuses whose event page is public (same rule as the IndexNow pings in EventsService). */
const PUBLIC_EVENT_STATUSES: readonly EventStatus[] = [
  "ACTIVE",
  "COMPLETED",
  "CANCELLED",
];
/** Orders are saved right after reading the event; wait this long so one already in flight lands before the re-check. */
const DELETE_RACE_GRACE_MS = 2000;
const CASH_LOCATIONS_PAGE_SLUG = "locations-page";
/**
 * Events whose organizer sponsor changes await an admin (list `pendingChanges=true`, count):
 * approved events (sponsors approve) and MODERATION ones (confirm approves them). A DRAFT or
 * REJECTED event's list waits for its resubmission, so it is left out. The status condition sits
 * in `$and` so it never replaces the list's own `status` filter.
 */
const PENDING_CHANGES_STATUSES: EventStatus[] = [...APPROVED_EVENT_STATUSES, "MODERATION"];
const PENDING_CHANGES_FILTER = {
  softDeleted: { $ne: true },
  archivedByOrganizer: { $ne: true },
  pendingSponsors: { $exists: true },
  $and: [{ status: { $in: PENDING_CHANGES_STATUSES } }],
};
/** Mirrors the empty legacy THB receiver written by EventsService.resolvePaymentOptionsForSave. */
const EMPTY_LEGACY_THB = {
  accountNumber: "",
  recipientName: "",
  phoneNumber: "",
  hasCustomQrCode: false,
  useLegacyQrFallback: true,
};

/** Admin-only event listing and detail (use with AdminGuard on controllers). */
@Injectable()
export class AdminEventsService {
  private readonly logger = new Logger(AdminEventsService.name);

  constructor(
    private readonly eventsService: EventsService,
    private readonly usersService: UsersService,
    private readonly adminsService: AdminsService,
    private readonly indexNowService: IndexNowService,
    private readonly approvalSnapshots: EventApprovalSnapshotsService,
    private readonly eventSponsorsService: EventSponsorsService,
    private readonly messengersNotifier: EventMessengersNotifierService,
  ) {}

  private get eventModel(): mongoose.Model<IEvent> {
    return (
      (mongoose.models.Event as mongoose.Model<IEvent>) ??
      mongoose.model<IEvent>("Event", EventSchema)
    );
  }

  private get ticketModel(): mongoose.Model<ITicket> {
    return (
      (mongoose.models.Ticket as mongoose.Model<ITicket>) ??
      mongoose.model<ITicket>("Ticket", TicketSchema)
    );
  }

  private get mockOrderModel(): mongoose.Model<IMockOrder> {
    return (
      (mongoose.models.MockOrder as mongoose.Model<IMockOrder>) ??
      mongoose.model<IMockOrder>("MockOrder", MockOrderSchema)
    );
  }

  private get sessionModel(): mongoose.Model<IEventSession> {
    return (
      (mongoose.models.EventSession as mongoose.Model<IEventSession>) ??
      mongoose.model<IEventSession>("EventSession", EventSessionSchema)
    );
  }

  private get reviewModel(): mongoose.Model<IReview> {
    return (
      (mongoose.models.Review as mongoose.Model<IReview>) ??
      mongoose.model<IReview>("Review", ReviewSchema)
    );
  }

  private get favoriteModel(): mongoose.Model<IFavorite> {
    return (
      (mongoose.models.Favorite as mongoose.Model<IFavorite>) ??
      mongoose.model<IFavorite>("Favorite", FavoriteSchema)
    );
  }

  private get managerModel(): mongoose.Model<IManager> {
    return (
      (mongoose.models.Manager as mongoose.Model<IManager>) ??
      mongoose.model<IManager>("Manager", ManagerSchema)
    );
  }

  private get promoCodeModel(): mongoose.Model<IPromoCode> {
    return (
      (mongoose.models.PromoCode as mongoose.Model<IPromoCode>) ??
      mongoose.model<IPromoCode>("PromoCode", PromoCodeSchema)
    );
  }

  private get bannerModel(): mongoose.Model<IBanner> {
    return (
      (mongoose.models.Banner as mongoose.Model<IBanner>) ??
      mongoose.model<IBanner>("Banner", BannerSchema)
    );
  }

  private get cashierModel(): mongoose.Model<ICashierArbi> {
    return (
      (mongoose.models.CashierArbi as mongoose.Model<ICashierArbi>) ??
      mongoose.model<ICashierArbi>("CashierArbi", CashierArbiSchema)
    );
  }

  private get cmsPageModel(): mongoose.Model<ICmsPage> {
    return (
      (mongoose.models.ContentCmsPage as mongoose.Model<ICmsPage>) ??
      mongoose.model<ICmsPage>("ContentCmsPage", CmsPageSchema)
    );
  }

  private get deletedEventModel(): mongoose.Model<IDeletedEvent> {
    return (
      (mongoose.models.DeletedEvent as mongoose.Model<IDeletedEvent>) ??
      mongoose.model<IDeletedEvent>("DeletedEvent", DeletedEventSchema)
    );
  }

  private computeEventCapacity(event: Pick<IEvent, "sectors">): number {
    let total = 0;
    for (const sector of event.sectors ?? []) {
      for (const zone of sector.zones ?? []) {
        total += zone.seats ?? 0;
      }
    }
    return total;
  }

  private organizerDisplayName(user: IUser | undefined): string {
    if (!user) {
      return "";
    }
    const candidates = [
      user.displayName,
      user.companyVenueName,
      user.responsiblePersonFullName,
      user.email,
    ];
    for (const c of candidates) {
      if (typeof c === "string" && c.trim()) {
        return c.trim();
      }
    }
    return "";
  }

  private async countTicketsSoldByEventIds(
    eventIds: number[],
  ): Promise<Map<number, number>> {
    const map = new Map<number, number>();
    if (!eventIds.length) {
      return map;
    }
    const rows = await this.ticketModel
      .aggregate<{
        _id: number;
        sold: number;
      }>([
        {
          $match: { eventId: { $in: eventIds } },
        },
        {
          $group: { _id: "$eventId", sold: { $sum: 1 } },
        },
      ])
      .exec();
    for (const r of rows) {
      map.set(r._id, r.sold);
    }
    return map;
  }

  getEvents(query: AdminEventsQueryDto): Promise<AdminEventsListResult> {
    return this.listEventsForAdmin({
      status: query.status,
      search: query.search,
      sortBy: query.sortBy,
      order: query.order,
      limit: query.limit,
      page: query.page,
      pendingChanges: query.pendingChanges === true,
    });
  }

  /**
   * `count`: events awaiting moderation (status MODERATION). `pendingChanges`: events whose
   * organizer sponsor changes await approval, in an approved status or MODERATION (same filter
   * as the list's `pendingChanges=true`; DRAFT and REJECTED are left out).
   */
  async getModerationEventsCount(): Promise<{ count: number; pendingChanges: number }> {
    // Архивированное организатором событие не ждёт модерации: его нет на сайте и оно заморожено.
    const [count, pendingChanges] = await Promise.all([
      this.eventModel
        .countDocuments({ status: "MODERATION", archivedByOrganizer: { $ne: true } })
        .exec(),
      this.eventModel.countDocuments(PENDING_CHANGES_FILTER).exec(),
    ]);
    return { count, pendingChanges };
  }

  /**
   * Admin list: filter, title search, sort, page/limit pagination.
   * `sold` = issued ticket documents for the event; `capacity` = sum of zone seats.
   */
  private async listEventsForAdmin(params: {
    status?: string;
    search?: string;
    sortBy?: "createdAt" | "eventDate";
    order?: "asc" | "desc";
    limit?: number;
    page?: number;
    pendingChanges?: boolean;
  }): Promise<AdminEventsListResult> {
    const sortBy = params.sortBy ?? "createdAt";
    const order = params.order ?? "desc";
    const page = Math.max(params.page ?? 1, 1);
    const pageLimit = Math.min(Math.max(params.limit ?? 20, 1), 100);
    const skip = (page - 1) * pageLimit;

    // Все события, в т.ч. мягко удалённые (помечены softDeleted).
    const filter: Record<string, unknown> = {};
    if (
      params.status?.trim() &&
      EVENT_STATUSES.includes(params.status as EventStatus)
    ) {
      filter.status = params.status.trim();
      // Как и счётчик модерации: архивированное организатором событие модерации не ждёт.
      if (filter.status === "MODERATION") {
        filter.archivedByOrganizer = { $ne: true };
      }
    }
    if (params.pendingChanges === true) {
      Object.assign(filter, PENDING_CHANGES_FILTER);
    }
    if (params.search?.trim()) {
      const term = params.search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(term, "i");
      filter.$or = [{ "title.th": re }, { "title.en": re }, { "title.ru": re }];
    }

    const sort: Record<string, 1 | -1> =
      sortBy === "eventDate"
        ? {
            "eventDate.startDate": order === "asc" ? 1 : -1,
            id: order === "asc" ? 1 : -1,
          }
        : { createdAt: order === "asc" ? 1 : -1, id: order === "asc" ? 1 : -1 };

    const [total, raw] = await Promise.all([
      this.eventModel.countDocuments(filter).exec(),
      this.eventModel
        .find(filter)
        .sort(sort)
        .skip(skip)
        .limit(pageLimit)
        .lean()
        .exec() as Promise<IEvent[]>,
    ]);

    const eventIds = raw.map((e) => e.id);

    const [usersById, soldByEvent] = await Promise.all([
      this.usersService.findManyByNumericIds(raw.map((e) => e.creator)),
      this.countTicketsSoldByEventIds(eventIds),
    ]);

    const items: AdminEventListItem[] = raw.map((e) => ({
      id: e.id,
      creator: e.creator,
      organizerName: this.organizerDisplayName(usersById.get(e.creator)),
      organizerVerificationStatus:
        usersById.get(e.creator)?.verificationStatus ?? "approved",
      status: e.status,
      title: e.title,
      category: e.category,
      province: e.province,
      city: e.city ?? null,
      venue: venueLabel(e.venue),
      eventDate: e.eventDate,
      sold: soldByEvent.get(e.id) ?? 0,
      capacity: this.computeEventCapacity(e),
      // Regular events sell per session, so the registry has to distinguish them.
      isRecurring: e.recurrence?.enabled === true,
      // Организатор скрыл событие с сайта (не статус; админка только показывает).
      hiddenFromSite: e.hiddenFromSite === true,
      // Организатор перенёс событие в архив (не статус; админка только показывает).
      archivedByOrganizer: e.archivedByOrganizer === true,
      softDeleted: e.softDeleted === true,
      hasPendingSponsors: Array.isArray(e.pendingSponsors),
      rejectReason: e.rejectReason,
      createdAt: e.createdAt,
    }));

    return { items, total, page, limit: pageLimit };
  }

  getEventById(id: number): Promise<AdminEventDetails> {
    return this.getAdminEventDetailsById(id);
  }

  /**
   * Publishes the event (status → ACTIVE) only when current status is MODERATION. Approving
   * the event approves the organizer's pending sponsors with it, and the approved state becomes
   * the approval snapshot (the baseline of the next "changed since approval" diff).
   */
  async confirmEvent(id: number, adminId?: string): Promise<AdminEventDetails> {
    const { before, after } = await updateEventGuarded(
      this.eventModel,
      id,
      { status: "MODERATION" },
      (current) => {
        if (current.status !== "MODERATION") {
          throw new BadRequestException(ADMIN_EVENT_ERROR.NOT_IN_MODERATION);
        }
        const set: Record<string, unknown> = { status: "ACTIVE" };
        const unset: Record<string, 1> = { rejectReason: 1 };
        this.applyPendingSponsors(current, set, unset);
        return toUpdateQuery(set, unset);
      },
    );
    // Event group chat (LINE): sales opened by the approval.
    void this.messengersNotifier
      .recheckSales(id, SALES_REASON.APPROVED_BY_ADMIN)
      .catch((err) => {
        this.logger.warn(
          `Messenger sales recheck failed for event ${id}: ${(err as Error)?.message}`,
        );
      });
    await this.recordApproval(before, after, adminId);
    return this.getEventById(id);
  }

  /**
   * Approves the organizer's pending sponsors of an approved event — ACTIVE, PAUSED, COMPLETED
   * or CANCELLED (option B: it kept selling meanwhile) — and writes the approval snapshot like
   * confirm. 409 `sponsors_not_pending` without a pending list; 409 `event_in_moderation` for a
   * MODERATION event (confirm does it); 409 `event_not_approved` for DRAFT or REJECTED, whose
   * unapproved edits the snapshot must not absorb (confirm does it after resubmission).
   */
  async approveSponsors(id: number, adminId?: string): Promise<AdminEventDetails> {
    const { before, after } = await updateEventGuarded(
      this.eventModel,
      id,
      { status: { $in: [...APPROVED_EVENT_STATUSES] }, pendingSponsors: { $exists: true } },
      (current) => {
        if (!Array.isArray(current.pendingSponsors)) {
          throw new ConflictException(EVENT_SPONSOR_ERROR.NOT_PENDING);
        }
        if (current.status === "MODERATION") {
          throw new ConflictException(EVENT_SPONSOR_ERROR.EVENT_IN_MODERATION);
        }
        if (!APPROVED_EVENT_STATUSES.includes(current.status)) {
          throw new ConflictException(EVENT_SPONSOR_ERROR.EVENT_NOT_APPROVED);
        }
        const set: Record<string, unknown> = {};
        const unset: Record<string, 1> = {};
        this.applyPendingSponsors(current, set, unset);
        return toUpdateQuery(set, unset);
      },
    );
    await this.recordApproval(before, after, adminId);
    this.logger.log(`Sponsors of event ${id} approved by adminId=${adminId}`);
    return this.getEventById(id);
  }

  /** Admin.id as stored in approval snapshots; `null` when the guard's id is not numeric. */
  private adminIdOrNull(adminId: string | undefined): number | null {
    const n = Number(adminId);
    return adminId !== undefined && adminId !== "" && Number.isSafeInteger(n) ? n : null;
  }

  /** Moves `pendingSponsors` into `sponsors`; nothing to do without a pending list. */
  private applyPendingSponsors(
    event: IEvent,
    set: Record<string, unknown>,
    unset: Record<string, 1>,
  ): void {
    if (!Array.isArray(event.pendingSponsors)) {
      return;
    }
    const pending = sponsorsShape(event.pendingSponsors);
    if (pending.length) {
      set.sponsors = pending;
    } else {
      unset.sponsors = 1;
    }
    unset.pendingSponsors = 1;
    unset.pendingSponsorsAt = 1;
  }

  /**
   * After confirm / sponsors approve: the approved state becomes the approval snapshot, then
   * logos the approval replaced are deleted when nothing references them. Best effort (logged):
   * the approval itself has already landed.
   */
  private async recordApproval(
    before: IEvent,
    after: IEvent,
    adminId: string | undefined,
  ): Promise<void> {
    let previousLogos: number[] = [];
    try {
      const previous = await this.approvalSnapshots.findByEventId(after.id);
      previousLogos = sponsorLogoIds(this.approvalSnapshots.sponsorsOf(previous));
      await this.approvalSnapshots.writeApproval(after, this.adminIdOrNull(adminId));
    } catch (err) {
      this.logger.error(
        `Approval snapshot of event ${after.id} was not written (adminId=${adminId}): ${(err as Error).message}`,
      );
    }
    await this.eventSponsorsService.removeUnreferencedLogos(after.id, [
      ...sponsorLogoIds(before.sponsors),
      ...previousLogos,
    ]);
  }

  /** Sets status to REJECTED only when current status is MODERATION. */
  async rejectEvent(id: number, rejectReason: string): Promise<AdminEventDetails> {
    const updated = await this.eventModel
      .findOneAndUpdate(
        { id, status: "MODERATION" },
        { $set: { status: "REJECTED", rejectReason } },
        { new: true },
      )
      .lean()
      .exec();

    if (!updated) {
      const existing = await this.eventModel.findOne({ id }).lean().exec();
      if (!existing) {
        throw new NotFoundException("Event not found");
      }
      throw new BadRequestException(ADMIN_EVENT_ERROR.NOT_IN_MODERATION);
    }

    return this.getEventById(id);
  }

  /** Overwrites localized `description` for any event (admin). */
  async updateEventDescription(
    id: number,
    description: ILocalizedText,
  ): Promise<AdminEventDetails> {
    const updated = await this.eventModel
      .findOneAndUpdate({ id }, { $set: { description } }, { new: true })
      .lean()
      .exec();

    if (!updated) {
      throw new NotFoundException("Event not found");
    }
    // An admin edit is not an organizer change: the approval snapshot follows it.
    try {
      await this.approvalSnapshots.syncAdminEdit(id, updated, ["description"]);
    } catch (err) {
      this.logger.error(
        `Approval snapshot description of event ${id} not updated: ${(err as Error).message}`,
      );
    }

    return this.getEventById(id);
  }

  private deletionConfirmationPhrase(id: number): string {
    return `DELETE ${id}`;
  }

  private async resolveAdminEmail(adminId: string): Promise<string> {
    const admin = await this.adminsService.findByIdPublic(adminId);
    return admin?.email ?? adminId;
  }

  /** Everything that references the event: orders by status, tickets, sessions and the links that would break. */
  private async collectDeletionCounts(
    id: number,
  ): Promise<{ counts: AdminEventDeletionCounts; activeBannerIds: number[] }> {
    // `id` is an integer from ParseIntPipe, so the pattern needs no escaping.
    const bannerHref = new RegExp(`/events/${id}(?:[-/?#]|$)`);
    const [
      orderRows,
      tickets,
      sessions,
      reviews,
      favorites,
      managers,
      promoCodes,
      activeBannerRows,
      inactiveBanners,
      payouts,
      arbipayStores,
    ] = await Promise.all([
      this.mockOrderModel
        .aggregate<{ _id: string; count: number }>([
          { $match: { event: id } },
          { $group: { _id: "$status", count: { $sum: 1 } } },
        ])
        .exec(),
      this.ticketModel.countDocuments({ eventId: id }).exec(),
      this.sessionModel.countDocuments({ eventId: id }).exec(),
      this.reviewModel.countDocuments({ eventId: id }).exec(),
      this.favoriteModel.countDocuments({ eventId: id }).exec(),
      this.managerModel
        .countDocuments({ $or: [{ events: id }, { event: id }] })
        .exec(),
      this.promoCodeModel
        .countDocuments({ applicableEventIds: String(id) })
        .exec(),
      this.bannerModel
        .find({ isActive: true, href: bannerHref })
        .select({ id: 1 })
        .lean()
        .exec(),
      this.bannerModel
        .countDocuments({ isActive: { $ne: true }, href: bannerHref })
        .exec(),
      countEventPayouts(id),
      countEventArbiPayStores(id),
    ]);

    const orders = { total: 0 } as AdminEventDeletionCounts["orders"];
    for (const status of MOCK_ORDER_STATUSES) {
      orders[status] = 0;
    }
    for (const row of orderRows) {
      if ((MOCK_ORDER_STATUSES as readonly string[]).includes(row._id)) {
        orders[row._id as MockOrderStatus] = row.count;
      }
      // An unknown legacy status still counts towards the total the admin sees.
      orders.total += row.count;
    }

    return {
      counts: {
        orders,
        tickets,
        sessions,
        reviews,
        favorites,
        managers,
        promoCodes,
        activeBanners: activeBannerRows.length,
        inactiveBanners,
        payouts,
        arbipayStores,
      },
      activeBannerIds: activeBannerRows.map((b) => b.id),
    };
  }

  /** Public: also used by AdminVaultEventsService (event cleanup overview). */
  deletionBlockers(
    counts: AdminEventDeletionCounts,
  ): AdminEventDeletionBlocker[] {
    const blockers: AdminEventDeletionBlocker[] = [];
    if (counts.orders.wait > 0) {
      blockers.push("has_wait_orders");
    }
    if (counts.orders.pending_cash > 0) {
      blockers.push("has_pending_cash_orders");
    }
    if (counts.orders.paid > 0) {
      blockers.push("has_paid_orders");
    }
    if (counts.orders.refunded > 0) {
      blockers.push("has_refunded_orders");
    }
    if (counts.tickets > 0) {
      blockers.push("has_tickets");
    }
    if (counts.payouts > 0) {
      blockers.push("has_payouts");
    }
    if (counts.activeBanners > 0) {
      blockers.push("linked_from_active_banner");
    }
    return blockers;
  }

  /** Public: also used by AdminVaultEventsService (event cleanup overview). */
  deletionWarnings(
    event: {
      status: EventStatus;
      hiddenFromSite?: boolean | null;
      archivedByOrganizer?: boolean | null;
    },
    counts: AdminEventDeletionCounts,
  ): AdminEventDeletionWarning[] {
    const warnings: AdminEventDeletionWarning[] = [];
    if (event.status === "ACTIVE") {
      warnings.push("event_is_active");
    }
    // Архив организатора убирает страницу с сайта так же, как «скрыть с сайта».
    if (
      (event.status === "COMPLETED" || event.status === "CANCELLED") &&
      !isHiddenFromSite(event)
    ) {
      warnings.push("event_page_public");
    }
    if (counts.orders.expired + counts.orders.cancelled > 0) {
      warnings.push("cash_bookings_unrecoverable");
    }
    if (counts.orders.failed > 0) {
      warnings.push("failed_orders_left");
    }
    if (counts.reviews > 0) {
      warnings.push("reviews_left");
    }
    if (counts.favorites > 0) {
      warnings.push("favorites_left");
    }
    if (counts.managers > 0) {
      warnings.push("managers_detached");
    }
    if (counts.promoCodes > 0) {
      warnings.push("promo_codes_left");
    }
    if (counts.inactiveBanners > 0) {
      warnings.push("inactive_banner_links");
    }
    if (counts.arbipayStores > 0) {
      warnings.push("soft_delete_arbipay_store");
    }
    return warnings;
  }

  /** Best effort: the archive state is audit data and must never fail the request. */
  private async updateDeletedEventArchive(
    archiveId: unknown,
    set: Partial<
      Pick<IDeletedEvent, "event" | "sessions" | "cleanupErrors">
    > & {
      state: DeletedEventState;
    },
  ): Promise<void> {
    try {
      await this.deletedEventModel
        .updateOne({ _id: archiveId }, { $set: set })
        .exec();
    } catch (err) {
      this.logger.error(
        `Could not set deletedevents ${String(archiveId)} state=${set.state}: ${(err as Error).message}`,
      );
    }
  }

  /** Preflight for the admin delete dialog; `deleteEvent` re-checks everything itself. */
  async getDeletionCheck(id: number): Promise<AdminEventDeletionCheck> {
    // No ensureEventMediaIds here: it may write to the DB or throw on a broken cover.
    const event = await this.eventModel
      .findOne({ id })
      .select({ id: 1, title: 1, status: 1, hiddenFromSite: 1, archivedByOrganizer: 1 })
      .lean()
      .exec();
    if (!event) {
      throw new NotFoundException("Event not found");
    }
    const { counts, activeBannerIds } = await this.collectDeletionCounts(id);
    const blockers = this.deletionBlockers(counts);
    return {
      id,
      title: event.title,
      status: event.status,
      hiddenFromSite: event.hiddenFromSite === true,
      archivedByOrganizer: event.archivedByOrganizer === true,
      confirmationPhrase: this.deletionConfirmationPhrase(id),
      counts,
      activeBannerIds,
      blockers,
      warnings: this.deletionWarnings(event, counts),
      canDelete: blockers.length === 0,
    };
  }

  /**
   * Hard-deletes an event without sales: typed phrase check, blockers re-checked,
   * archive snapshot written first, rollback if a blocking order lands meanwhile
   * or the re-check itself fails.
   * Media, reviews, favorites, orders, tickets, promo codes and banners are left untouched.
   */
  async deleteEvent(
    id: number,
    confirmation: string,
    adminId: string,
  ): Promise<AdminEventDeleteResult> {
    if (
      typeof confirmation !== "string" ||
      confirmation.trim() !== this.deletionConfirmationPhrase(id)
    ) {
      this.logger.warn(
        `Event ${id} delete refused: confirmation mismatch (adminId=${adminId})`,
      );
      throw new BadRequestException(
        ADMIN_EVENT_ERROR.DELETE_CONFIRMATION_MISMATCH,
      );
    }

    const existing = await this.eventModel.findOne({ id }).lean().exec();
    if (!existing) {
      throw new NotFoundException("Event not found");
    }

    const adminEmail = await this.resolveAdminEmail(adminId);
    // Never trust the preflight: the event may have sold tickets since the dialog opened.
    const { counts } = await this.collectDeletionCounts(id);
    const blockers = this.deletionBlockers(counts);
    if (blockers.length) {
      this.logger.warn(
        `Event ${id} delete blocked (${blockers.join(",")}) for adminId=${adminId} (${adminEmail})`,
      );
      throw new ConflictException({
        statusCode: 409,
        message: ADMIN_EVENT_ERROR.DELETE_BLOCKED,
        error: "Conflict",
        blockers,
        counts,
        rolledBack: false,
      });
    }
    // Есть точка ARBI Pay: событие остаётся в базе (мягкое удаление), админка его видит.
    if (counts.arbipayStores > 0) {
      const soft = await softDeleteEvent(existing, `admin:${adminId}`, this.logger);
      if (soft.changed && PUBLIC_EVENT_STATUSES.includes(existing.status)) {
        this.indexNowService.notifyPaths([this.indexNowService.eventPath(id, existing.title?.en), "/events"]);
      }
      this.logger.log(`Event ${id} soft-deleted (ARBI Pay store) by adminId=${adminId} (${adminEmail}); changed=${soft.changed}; managersDetached=${soft.managersDetached}; cleanupErrors=${soft.errors.length}`);
      return { ok: true, id, archiveId: null, softDeleted: true };
    }

    // Archive before deleting: if it cannot be written, nothing is deleted.
    let archive: IDeletedEvent;
    let sessions: Record<string, unknown>[];
    try {
      const [sessionRows, managerRows] = await Promise.all([
        this.sessionModel.find({ eventId: id }).lean().exec(),
        this.managerModel
          .find({ $or: [{ events: id }, { event: id }] })
          .select({
            id: 1,
            type: 1,
            allEvents: 1,
            events: 1,
            event: 1,
            createdByUserId: 1,
          })
          .lean()
          .exec(),
      ]);
      sessions = sessionRows;
      archive = await this.deletedEventModel.create({
        eventId: id,
        eventStatus: existing.status,
        creator: existing.creator,
        title: existing.title,
        event: existing,
        sessions,
        managers: managerRows,
        counts,
        deletedByAdminId: Number.isFinite(Number(adminId))
          ? Number(adminId)
          : null,
        deletedByAdminEmail: adminEmail,
        deletedAt: new Date(),
        state: "archived",
      });
    } catch (err) {
      this.logger.error(
        `Event ${id} delete aborted: archive write failed (adminId=${adminId}): ${(err as Error).message}`,
      );
      throw new InternalServerErrorException(
        ADMIN_EVENT_ERROR.DELETE_ARCHIVE_FAILED,
      );
    }

    const deleted = await this.eventModel
      .findOneAndDelete({ id })
      .lean()
      .exec();
    if (!deleted) {
      await this.updateDeletedEventArchive(archive._id, { state: "aborted" });
      throw new NotFoundException("Event not found");
    }

    // An order that read the event just before the delete is saved within milliseconds:
    // wait for it, and put the event back if one appeared (sessions/managers are untouched so far).
    // A re-check that cannot run counts as unsafe: fail closed and restore the event too.
    let late: { orders: number; tickets: number } | null = null;
    try {
      await new Promise((resolve) => setTimeout(resolve, DELETE_RACE_GRACE_MS));
      const [orders, tickets] = await Promise.all([
        this.mockOrderModel
          .countDocuments({
            event: id,
            status: { $in: [...DELETE_BLOCKING_ORDER_STATUSES] },
          })
          .exec(),
        this.ticketModel.countDocuments({ eventId: id }).exec(),
      ]);
      late = { orders, tickets };
    } catch (err) {
      this.logger.error(
        `Event ${id} delete re-check failed, restoring the event (adminId=${adminId}, archive=${String(archive._id)}): ${(err as Error).message}`,
      );
    }
    if (!late || late.orders + late.tickets > 0) {
      try {
        // Raw driver insert keeps the original _id, id and timestamps; no plugin runs.
        await this.eventModel.collection.insertOne(
          deleted as mongoose.AnyObject,
        );
      } catch (err) {
        await this.updateDeletedEventArchive(archive._id, {
          state: "rollback_failed",
        });
        this.logger.error(
          `CRITICAL: event ${id} deleted but could not be restored (${late ? "late orders" : "re-check failed"}); restore from deletedevents ${String(archive._id)}: ${(err as Error).message}`,
        );
        throw new InternalServerErrorException(
          ADMIN_EVENT_ERROR.DELETE_ROLLBACK_FAILED,
        );
      }
      await this.updateDeletedEventArchive(archive._id, {
        state: "rolled_back",
      });
      if (!late) {
        this.logger.warn(
          `Event ${id} delete rolled back: re-check failed (adminId=${adminId}, archive=${String(archive._id)})`,
        );
        throw new InternalServerErrorException(
          ADMIN_EVENT_ERROR.DELETE_RECHECK_FAILED,
        );
      }
      this.logger.warn(
        `Event ${id} delete rolled back: ${late.orders} order(s)/${late.tickets} ticket(s) appeared (adminId=${adminId}, archive=${String(archive._id)})`,
      );
      const { counts: freshCounts } = await this.collectDeletionCounts(id);
      throw new ConflictException({
        statusCode: 409,
        message: ADMIN_EVENT_ERROR.DELETE_BLOCKED,
        error: "Conflict",
        blockers: this.deletionBlockers(freshCounts),
        counts: freshCounts,
        rolledBack: true,
      });
    }

    // The event is gone: cleanup below is best effort and never throws.
    const cleanupErrors: string[] = [];
    let finalSessions: Record<string, unknown>[] | undefined;
    let sessionsDeleted = 0;
    try {
      finalSessions = await this.sessionModel
        .find({ eventId: id })
        .lean()
        .exec();
      ({ deletedCount: sessionsDeleted } = await this.sessionModel
        .deleteMany({ eventId: id })
        .exec());
    } catch (err) {
      cleanupErrors.push("sessions_cleanup_failed");
      this.logger.error(
        `Event ${id} deleted but its sessions were not (archive=${String(archive._id)}): ${(err as Error).message}`,
      );
    }
    const links = await cleanUpDeletedEventLinks(id, this.logger, `archive=${String(archive._id)}`);
    cleanupErrors.push(...links.errors);

    await this.updateDeletedEventArchive(archive._id, {
      state: "deleted",
      event: deleted,
      sessions: finalSessions ?? sessions,
      cleanupErrors,
    });

    if (PUBLIC_EVENT_STATUSES.includes(deleted.status)) {
      this.indexNowService.notifyPaths([
        this.indexNowService.eventPath(id, deleted.title?.en),
        "/events",
      ]);
    }

    this.logger.log(
      `Event ${id} deleted by adminId=${adminId} (${adminEmail}); archive=${String(archive._id)}; sessions=${sessionsDeleted}; managersDetached=${links.managersDetached}; cleanupErrors=${cleanupErrors.length}`,
    );

    return { ok: true, id, archiveId: String(archive._id), softDeleted: false };
  }

  /** Cash payment as the site sees it, plus non-blocking prerequisite hints for the admin. */
  async getCashPaymentState(id: number): Promise<AdminEventCashPaymentState> {
    const raw = (await this.eventModel
      .findOne({ id })
      .lean()
      .exec()) as IEvent | null;
    if (!raw) {
      throw new NotFoundException("Event not found");
    }

    const [locationsPage, activeCashiers] = await Promise.all([
      this.cmsPageModel
        .findOne({ slug: CASH_LOCATIONS_PAGE_SLUG, publication: "published" })
        .select({ sections: 1 })
        .lean()
        .exec(),
      this.cashierModel.countDocuments({ isActive: { $ne: false } }).exec(),
    ]);

    // Same visibility rules as the public CMS page (visible section, card not hidden).
    let visibleCashLocations = 0;
    for (const section of locationsPage?.sections ?? []) {
      if (!section.visible) continue;
      for (const field of section.fields ?? []) {
        if (field.type !== "repeater" || !isLocationRepeaterId(field.id)) {
          continue;
        }
        visibleCashLocations += field.items.filter(
          (item) => item.showCard !== false,
        ).length;
      }
    }

    const warnings: AdminEventCashPaymentWarning[] = [];
    if (visibleCashLocations === 0) {
      warnings.push("no_visible_cash_locations");
    }
    if (activeCashiers === 0) {
      warnings.push("no_active_cashiers");
    }
    if (isSalesClosed(raw)) {
      warnings.push("event_sales_closed");
    }
    // Архивированное организатором событие тоже снято с сайта и не принимает заказы.
    if (isHiddenFromSite(raw)) {
      warnings.push("event_hidden_from_site");
    }

    return {
      id,
      // withPaymentOptionsFallback forces cashEnabled=false when thb is missing.
      cashEnabled:
        Boolean(raw.paymentOptions?.thb) &&
        raw.paymentOptions?.cashEnabled === true,
      cashFeePercent: resolveEventFeePercents(raw).cashFeePercent,
      status: raw.status,
      hiddenFromSite: raw.hiddenFromSite === true,
      archivedByOrganizer: raw.archivedByOrganizer === true,
      visibleCashLocations,
      activeCashiers,
      warnings,
    };
  }

  /** Sets the desired cash payment state (not a toggle); never overwrites an existing THB receiver or QR. */
  async setCashPayment(
    id: number,
    enabled: boolean,
    adminId: string,
  ): Promise<AdminEventCashPaymentState> {
    const existing = await this.eventModel
      .findOne({ id })
      .select({ id: 1, paymentOptions: 1 })
      .lean()
      .exec();
    if (!existing) {
      throw new NotFoundException("Event not found");
    }
    const previous =
      Boolean(existing.paymentOptions?.thb) &&
      existing.paymentOptions?.cashEnabled === true;
    // Resolved before writing: a failed lookup must not report an error for a saved change.
    const adminEmail = await this.resolveAdminEmail(adminId);

    // Order matters: a dotted $set into `paymentOptions: null` fails in Mongo, so the
    // object is created first, then a missing thb is filled, then only the flag is set.
    // Each step is conditional and idempotent.
    await this.eventModel
      .updateOne(
        { id, paymentOptions: null },
        {
          $set: {
            paymentOptions: {
              thb: { ...EMPTY_LEGACY_THB },
              cashEnabled: enabled,
            },
          },
        },
      )
      .exec();
    await this.eventModel
      .updateOne(
        { id, paymentOptions: { $ne: null }, "paymentOptions.thb": null },
        { $set: { "paymentOptions.thb": { ...EMPTY_LEGACY_THB } } },
      )
      .exec();
    const res = await this.eventModel
      .updateOne({ id }, { $set: { "paymentOptions.cashEnabled": enabled } })
      .exec();
    if (!res.matchedCount) {
      throw new NotFoundException("Event not found");
    }

    this.logger.log(
      `Cash payment ${enabled ? "enabled" : "disabled"} for event ${id} (was ${previous ? "enabled" : "disabled"}) by adminId=${adminId} (${adminEmail})`,
    );
    // An admin switch is not an organizer change: the approval snapshot follows it.
    try {
      const current = await this.eventModel
        .findOne({ id })
        .select({ paymentOptions: 1 })
        .lean()
        .exec();
      await this.approvalSnapshots.syncAdminCashEnabled(id, current);
    } catch (err) {
      this.logger.error(
        `Approval snapshot cash switch of event ${id} not updated: ${(err as Error).message}`,
      );
    }

    return this.getCashPaymentState(id);
  }

  /**
   * Admin: single event by numeric id (no organizer scope).
   * `sold` = ticket documents for this event; `capacity` = sum of zone seats.
   */
  private async getAdminEventDetailsById(
    id: number,
  ): Promise<AdminEventDetails> {
    const raw = (await this.eventModel
      .findOne({ id })
      .lean()
      .exec()) as IEvent | null;
    if (!raw) {
      throw new NotFoundException("Event not found");
    }
    const event = await this.eventsService.ensureEventMediaIds(raw);
    const [usersById, soldMap, snapshot] = await Promise.all([
      this.usersService.findManyByNumericIds([event.creator]),
      this.countTicketsSoldByEventIds([event.id]),
      this.approvalSnapshots.findByEventId(event.id),
    ]);
    const organizerName = this.organizerDisplayName(
      usersById.get(event.creator),
    );
    const sold = soldMap.get(event.id) ?? 0;
    const capacity = this.computeEventCapacity(event);
    const fees = resolveEventFeePercents(event);
    // Комиссия за наличные редактируется на той же карточке, что остальные проценты.

    return {
      id: event.id,
      creator: event.creator,
      status: event.status,
      title: event.title,
      description: event.description,
      eventLanguage: event.eventLanguage,
      coverImage: event.coverImage,
      seatingPlanImage: event.seatingPlanImage,
      seatingPlanSeats: event.seatingPlanSeats,
      parkingPlanImage: event.parkingPlanImage,
      parkingPlanSeats: event.parkingPlanSeats,
      eventDate: event.eventDate,
      time: event.time,
      category: event.category,
      tags: event.tags ?? [],
      province: event.province,
      city: event.city ?? null,
      venue: event.venue,
      sectors: event.sectors ?? [],
      externalLinks: event.externalLinks ?? [],
      refundPolicy: event.refundPolicy,
      hiddenFromSite: event.hiddenFromSite === true,
      archivedByOrganizer: event.archivedByOrganizer === true,
      softDeleted: event.softDeleted === true,
      softDeletedAt: event.softDeletedAt ?? null,
      softDeletedBy: event.softDeletedBy ?? null,
      rejectReason: event.rejectReason,
      createdAt: event.createdAt,
      updatedAt: event.updatedAt,
      organizerName,
      organizerVerificationStatus:
        usersById.get(event.creator)?.verificationStatus ?? "approved",
      sold,
      capacity,
      vatPercent: fees.vatPercent,
      additionalTicketCostFeePercent: fees.additionalTicketCostFeePercent,
      processingFeePercent: fees.processingFeePercent,
      platformFeePercent: fees.platformFeePercent,
      cashFeePercent: fees.cashFeePercent,
      // Уже после ensureEventMediaIds: без thb фолбэк выставляет false, как на сайте.
      cashEnabled: event.paymentOptions?.cashEnabled === true,
      galleryImages: (event.galleryImages ?? []).filter(
        (mediaId) => typeof mediaId === "number",
      ),
      recurrence: event.recurrence ?? null,
      venueSchedule: event.venueSchedule ?? null,
      salesCloseBefore: event.salesCloseBefore ?? null,
      ticketCopyEmail: event.ticketCopyEmail ?? null,
      paymentOptions: paymentOptionsSummary(event.paymentOptions),
      sponsors: sponsorsShape(event.sponsors),
      pendingSponsors: Array.isArray(event.pendingSponsors)
        ? sponsorsShape(event.pendingSponsors)
        : null,
      pendingSponsorsAt: event.pendingSponsorsAt
        ? new Date(event.pendingSponsorsAt).toISOString()
        : null,
      ticketFormat: event.ticketFormat === "pdf" ? "pdf" : "webp",
      // Sponsors of the current side: the organizer's latest list (pending ?? approved).
      changes: {
        baselineAt: snapshot ? new Date(snapshot.approvedAt).toISOString() : null,
        fields: snapshot
          ? diffEventModerationShapes(
              snapshot.data,
              buildEventModerationShape(event, "current"),
            )
          : [],
      },
    };
  }
}
