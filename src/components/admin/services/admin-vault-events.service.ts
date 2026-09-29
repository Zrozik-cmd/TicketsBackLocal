import { Injectable } from "@nestjs/common";
import mongoose from "mongoose";
import { EventSchema, IEvent } from "../../events/schemas/event.schema";
import { ITicket, TicketSchema } from "../../tickets/schemas/ticket.schema";
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
import { roundMoney } from "../../mock-orders/utils/mock-order-refund.util";
import { UsersService } from "../../users/users.service";
import type { IUser } from "../../users/schemas/user.schema";
import { AdminVaultEventsQueryDto } from "../dto/admin-vault-events-query.dto";
import type { AdminEventDeletionCounts } from "../types/admin-event.types";
import type {
  AdminVaultEventRow,
  AdminVaultEventsResult,
} from "../types/admin-vault.types";
import { AdminEventsService } from "./admin-events.service";
import { countPayoutsByEvent } from "../../finance/finance-event-links";
import { countArbiPayStoresByEvent } from "../../arbipay-stores/arbipay-store-event-links";

type VaultEventDoc = Pick<
  IEvent,
  | "id"
  | "title"
  | "status"
  | "hiddenFromSite"
  | "archivedByOrganizer"
  | "softDeleted"
  | "city"
  | "eventDate"
  | "recurrence"
  | "creator"
  | "sectors"
  | "createdAt"
  | "updatedAt"
>;

/** Any `/events/<id>` link in a banner href, same boundary rule as the admin deletion check. */
const BANNER_EVENT_HREF = /\/events\/(\d+)(?:[-/?#]|$)/g;

const ICT_DAY_FORMAT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Bangkok",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function incrementCount(map: Map<number, number>, key: number, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

/**
 * Admin vault: every event (soft-deleted included) with everything that decides whether
 * it can be deleted. Blockers and warnings come from AdminEventsService, so the overview
 * and the delete dialog never disagree. Counts are batched over all matched events;
 * sorting and paging happen in memory because `sold` / `revenue` are computed.
 */
@Injectable()
export class AdminVaultEventsService {
  constructor(
    private readonly adminEventsService: AdminEventsService,
    private readonly usersService: UsersService,
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

  /** Same fallback chain as the admin events list. */
  private organizerDisplayName(user: IUser | undefined): string {
    if (!user) {
      return "";
    }
    for (const c of [
      user.displayName,
      user.companyVenueName,
      user.responsiblePersonFullName,
      user.email,
    ]) {
      if (typeof c === "string" && c.trim()) {
        return c.trim();
      }
    }
    return "";
  }

  private computeCapacity(event: Pick<IEvent, "sectors">): number {
    let total = 0;
    for (const sector of event.sectors ?? []) {
      for (const zone of sector.zones ?? []) {
        total += zone.seats ?? 0;
      }
    }
    return total;
  }

  /** The last day of the event (a regular one: its period end) is before today in ICT. */
  private isPastEvent(event: VaultEventDoc, todayIct: string): boolean {
    const lastDay =
      event.recurrence?.enabled === true && event.recurrence.periodEnd
        ? event.recurrence.periodEnd
        : event.eventDate?.endDate || event.eventDate?.startDate;
    if (!lastDay) {
      return false;
    }
    return lastDay.slice(0, 10) < todayIct;
  }

  async listEvents(
    query: AdminVaultEventsQueryDto,
  ): Promise<AdminVaultEventsResult> {
    const page = Math.max(query.page ?? 1, 1);
    const limit = Math.min(Math.max(query.limit ?? 25, 1), 100);
    const sortBy = query.sortBy ?? "createdAt";
    const direction = query.order === "asc" ? 1 : -1;

    // No softDeleted filter: the vault shows everything that still exists.
    const filter: Record<string, unknown> = {};
    if (query.status) {
      filter.status = query.status;
    }
    const search = query.search?.trim();
    if (search) {
      const re = new RegExp(escapeRegex(search), "i");
      const or: Record<string, unknown>[] = [
        { "title.th": re },
        { "title.en": re },
        { "title.ru": re },
      ];
      if (/^\d+$/.test(search) && Number.isSafeInteger(Number(search))) {
        or.push({ id: Number(search) });
      }
      filter.$or = or;
    }

    const events = (await this.eventModel
      .find(filter)
      .select({
        id: 1,
        title: 1,
        status: 1,
        hiddenFromSite: 1,
        archivedByOrganizer: 1,
        softDeleted: 1,
        city: 1,
        eventDate: 1,
        recurrence: 1,
        creator: 1,
        sectors: 1,
        createdAt: 1,
        updatedAt: 1,
      })
      .lean()
      .exec()) as unknown as VaultEventDoc[];

    if (!events.length) {
      return { items: [], total: 0, page, limit, deletableTotal: 0 };
    }

    const ids = events.map((e) => e.id);
    const idSet = new Set(ids);

    const [
      ticketRows,
      orderRows,
      sessionRows,
      reviewRows,
      favoriteRows,
      managers,
      promoCodes,
      banners,
      usersById,
      payoutsByEvent,
      storesByEvent,
    ] = await Promise.all([
      this.ticketModel
        .aggregate<{ _id: { e: number; s: string }; n: number }>([
          { $match: { eventId: { $in: ids } } },
          {
            $group: {
              _id: { e: "$eventId", s: "$status" },
              n: { $sum: 1 },
            },
          },
        ])
        .exec(),
      this.mockOrderModel
        .aggregate<{
          _id: { e: number; s: string };
          n: number;
          revenue: number;
          lastOrderAt: Date | null;
        }>([
          { $match: { event: { $in: ids } } },
          {
            $group: {
              _id: { e: "$event", s: "$status" },
              n: { $sum: 1 },
              revenue: {
                $sum: {
                  $cond: [{ $eq: ["$status", "paid"] }, "$total_price", 0],
                },
              },
              lastOrderAt: { $max: "$createdAt" },
            },
          },
        ])
        .exec(),
      this.countByEventId(this.sessionModel, ids),
      this.countByEventId(this.reviewModel, ids),
      this.countByEventId(this.favoriteModel, ids),
      this.managerModel
        .find({ $or: [{ events: { $in: ids } }, { event: { $in: ids } }] })
        .select({ events: 1, event: 1 })
        .lean()
        .exec(),
      this.promoCodeModel
        .find({ applicableEventIds: { $in: ids.map(String) } })
        .select({ applicableEventIds: 1 })
        .lean()
        .exec(),
      this.bannerModel
        .find({ href: /\/events\/\d+/ })
        .select({ id: 1, isActive: 1, href: 1 })
        .lean()
        .exec(),
      this.usersService.findManyByNumericIds(events.map((e) => e.creator)),
      countPayoutsByEvent(ids),
      countArbiPayStoresByEvent(ids),
    ]);

    const ticketsByEvent = new Map<number, number>();
    const usedByEvent = new Map<number, number>();
    for (const row of ticketRows) {
      incrementCount(ticketsByEvent, row._id.e, row.n);
      if (row._id.s === "USED") {
        incrementCount(usedByEvent, row._id.e, row.n);
      }
    }

    const ordersByEvent = new Map<number, AdminEventDeletionCounts["orders"]>();
    const revenueByEvent = new Map<number, number>();
    const lastOrderByEvent = new Map<number, number>();
    for (const row of orderRows) {
      let orders = ordersByEvent.get(row._id.e);
      if (!orders) {
        orders = this.emptyOrderCounts();
        ordersByEvent.set(row._id.e, orders);
      }
      if ((MOCK_ORDER_STATUSES as readonly string[]).includes(row._id.s)) {
        orders[row._id.s as MockOrderStatus] += row.n;
      }
      // An unknown legacy status still counts towards the total.
      orders.total += row.n;
      revenueByEvent.set(
        row._id.e,
        (revenueByEvent.get(row._id.e) ?? 0) + (row.revenue ?? 0),
      );
      if (row.lastOrderAt) {
        const ms = new Date(row.lastOrderAt).getTime();
        if (ms > (lastOrderByEvent.get(row._id.e) ?? 0)) {
          lastOrderByEvent.set(row._id.e, ms);
        }
      }
    }

    const managersByEvent = new Map<number, number>();
    for (const manager of managers as Array<
      Pick<IManager, "events" | "event">
    >) {
      const assigned = new Set<number>(manager.events ?? []);
      if (typeof manager.event === "number") {
        assigned.add(manager.event);
      }
      for (const eventId of assigned) {
        if (idSet.has(eventId)) {
          incrementCount(managersByEvent, eventId);
        }
      }
    }

    const promoByEvent = new Map<number, number>();
    for (const promo of promoCodes as Array<
      Pick<IPromoCode, "applicableEventIds">
    >) {
      for (const eventId of new Set(
        (promo.applicableEventIds ?? []).map(Number),
      )) {
        if (idSet.has(eventId)) {
          incrementCount(promoByEvent, eventId);
        }
      }
    }

    const activeBannersByEvent = new Map<number, number[]>();
    const inactiveBannersByEvent = new Map<number, number>();
    for (const banner of banners as Array<
      Pick<IBanner, "id" | "isActive" | "href">
    >) {
      const linked = new Set<number>();
      for (const match of (banner.href ?? "").matchAll(BANNER_EVENT_HREF)) {
        linked.add(Number(match[1]));
      }
      for (const eventId of linked) {
        if (!idSet.has(eventId)) {
          continue;
        }
        if (banner.isActive === true) {
          const list = activeBannersByEvent.get(eventId) ?? [];
          list.push(banner.id);
          activeBannersByEvent.set(eventId, list);
        } else {
          incrementCount(inactiveBannersByEvent, eventId);
        }
      }
    }

    const todayIct = ICT_DAY_FORMAT.format(new Date());

    const rows: AdminVaultEventRow[] = events.map((event) => {
      const activeBannerIds = activeBannersByEvent.get(event.id) ?? [];
      const counts: AdminEventDeletionCounts = {
        orders: ordersByEvent.get(event.id) ?? this.emptyOrderCounts(),
        tickets: ticketsByEvent.get(event.id) ?? 0,
        sessions: sessionRows.get(event.id) ?? 0,
        reviews: reviewRows.get(event.id) ?? 0,
        favorites: favoriteRows.get(event.id) ?? 0,
        managers: managersByEvent.get(event.id) ?? 0,
        promoCodes: promoByEvent.get(event.id) ?? 0,
        activeBanners: activeBannerIds.length,
        inactiveBanners: inactiveBannersByEvent.get(event.id) ?? 0,
        payouts: payoutsByEvent.get(event.id) ?? 0,
        arbipayStores: storesByEvent.get(event.id) ?? 0,
      };
      const blockers = this.adminEventsService.deletionBlockers(counts);
      const warnings = this.adminEventsService.deletionWarnings(event, counts);
      const organizer = usersById.get(event.creator);
      const lastOrderMs = lastOrderByEvent.get(event.id);
      return {
        id: event.id,
        title: event.title,
        status: event.status,
        isDraft: event.status === "DRAFT",
        hiddenFromSite: event.hiddenFromSite === true,
        // May be absent on events saved before the organizer archive existed.
        archivedByOrganizer: event.archivedByOrganizer === true,
        softDeleted: event.softDeleted === true,
        city: event.city ?? null,
        eventDate: event.eventDate,
        isPast: this.isPastEvent(event, todayIct),
        isRecurring: event.recurrence?.enabled === true,
        creator: event.creator,
        organizerName: this.organizerDisplayName(organizer),
        organizerEmail: organizer?.email ?? null,
        createdAt: event.createdAt,
        updatedAt: event.updatedAt,
        capacity: this.computeCapacity(event),
        tickets: counts.tickets,
        usedTickets: usedByEvent.get(event.id) ?? 0,
        orders: counts.orders,
        paidRevenueTHB: roundMoney(revenueByEvent.get(event.id) ?? 0),
        lastOrderAt: lastOrderMs ? new Date(lastOrderMs).toISOString() : null,
        sessions: counts.sessions,
        reviews: counts.reviews,
        favorites: counts.favorites,
        managers: counts.managers,
        promoCodes: counts.promoCodes,
        activeBannerIds,
        inactiveBanners: counts.inactiveBanners,
        payouts: counts.payouts,
        arbipayStores: counts.arbipayStores,
        blockers,
        warnings,
        canDelete: blockers.length === 0,
      };
    });

    const deletableTotal = rows.filter((row) => row.canDelete).length;
    const filtered =
      query.deletable === "true"
        ? rows.filter((row) => row.canDelete)
        : query.deletable === "false"
          ? rows.filter((row) => !row.canDelete)
          : rows;

    const sortValue = (row: AdminVaultEventRow): number | string => {
      switch (sortBy) {
        case "updatedAt":
          return new Date(row.updatedAt).getTime() || 0;
        case "eventDate":
          return row.eventDate?.startDate ?? "";
        case "sold":
          return row.tickets;
        case "revenue":
          return row.paidRevenueTHB;
        default:
          return new Date(row.createdAt).getTime() || 0;
      }
    };
    filtered.sort((a, b) => {
      const av = sortValue(a);
      const bv = sortValue(b);
      if (av < bv) return -direction;
      if (av > bv) return direction;
      return (a.id - b.id) * direction;
    });

    const start = (page - 1) * limit;
    return {
      items: filtered.slice(start, start + limit),
      total: filtered.length,
      page,
      limit,
      deletableTotal,
    };
  }

  private emptyOrderCounts(): AdminEventDeletionCounts["orders"] {
    const orders = { total: 0 } as AdminEventDeletionCounts["orders"];
    for (const status of MOCK_ORDER_STATUSES) {
      orders[status] = 0;
    }
    return orders;
  }

  private async countByEventId(
    model: mongoose.Model<IEventSession> | mongoose.Model<IReview> | mongoose.Model<IFavorite>,
    ids: number[],
  ): Promise<Map<number, number>> {
    const rows = await (model as mongoose.Model<unknown>)
      .aggregate<{ _id: number; n: number }>([
        { $match: { eventId: { $in: ids } } },
        { $group: { _id: "$eventId", n: { $sum: 1 } } },
      ])
      .exec();
    return new Map(rows.map((row) => [row._id, row.n]));
  }
}
