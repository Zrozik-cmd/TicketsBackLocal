import { Injectable } from "@nestjs/common";
import mongoose from "mongoose";
import { EventSchema, IEvent } from "../../events/schemas/event.schema";
import { ITicket, TicketSchema } from "../../tickets/schemas/ticket.schema";
import { IScan, ScanSchema } from "../../tickets/schemas/scan.schema";
import {
  IMockOrder,
  MockOrderSchema,
} from "../../mock-orders/schemas/mock-order.schema";
import { resolvePaymentMethodLabel } from "../../mock-orders/utils/mock-order-refund.util";
import {
  CustomerSchema,
  ICustomer,
} from "../../customers/schemas/customer.schema";
import {
  EventSessionSchema,
  IEventSession,
} from "../../event-sessions/schemas/event-session.schema";
import { buildSectorZoneNames } from "../../ticket-registry/utils/sector-zone-names.util";
import { UsersService } from "../../users/users.service";
import type { IUser } from "../../users/schemas/user.schema";
import { AdminVaultTicketSearchQueryDto } from "../dto/admin-vault-ticket-search-query.dto";
import type {
  AdminVaultTicketItem,
  AdminVaultTicketSearchField,
  AdminVaultTicketsResult,
} from "../types/admin-vault.types";

/** Buyer look-ups by e-mail / name / phone stop here: a broader query needs a narrower term. */
const CUSTOMER_MATCH_CAP = 500;
const TICKET_CODE_FULL = /^TT-[A-Z0-9]{8}$/;

type VaultEventDoc = Pick<
  IEvent,
  | "id"
  | "title"
  | "status"
  | "hiddenFromSite"
  | "eventDate"
  | "city"
  | "recurrence"
  | "creator"
  | "sectors"
>;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function safeInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) {
    return null;
  }
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

function toIso(value: unknown): string | null {
  if (!value) {
    return null;
  }
  const date = new Date(value as string | Date);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Admin vault: ticket search across all events (buyer e-mail, ticket code, ids, booking
 * code, buyer name / phone, event title) with everything the admin needs before removing
 * a ticket — the order and its money, the buyer, the event. Only issued Ticket documents
 * are searched; refunded tickets have none.
 */
@Injectable()
export class AdminVaultTicketsService {
  constructor(private readonly usersService: UsersService) {}

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

  private get customerModel(): mongoose.Model<ICustomer> {
    return (
      (mongoose.models.Customer as mongoose.Model<ICustomer>) ??
      mongoose.model<ICustomer>("Customer", CustomerSchema)
    );
  }

  private get eventModel(): mongoose.Model<IEvent> {
    return (
      (mongoose.models.Event as mongoose.Model<IEvent>) ??
      mongoose.model<IEvent>("Event", EventSchema)
    );
  }

  private get sessionModel(): mongoose.Model<IEventSession> {
    return (
      (mongoose.models.EventSession as mongoose.Model<IEventSession>) ??
      mongoose.model<IEventSession>("EventSession", EventSessionSchema)
    );
  }

  private get scanModel(): mongoose.Model<IScan> {
    return (
      (mongoose.models.Scan as mongoose.Model<IScan>) ??
      mongoose.model<IScan>("Scan", ScanSchema)
    );
  }

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

  async search(
    query: AdminVaultTicketSearchQueryDto,
  ): Promise<AdminVaultTicketsResult> {
    const page = Math.max(query.page ?? 1, 1);
    const limit = Math.min(Math.max(query.limit ?? 25, 1), 100);
    const q = query.q?.trim() ?? "";
    const empty: AdminVaultTicketsResult = { items: [], total: 0, page, limit };
    const field = query.field ?? "auto";
    // Ticket / order ids 1-9 are exact matches, so the 2-character minimum does not apply to them.
    const exactIdTerm =
      /^\d+$/.test(q) &&
      (field === "auto" || field === "ticketId" || field === "orderId");
    if (q.length < 2 && !exactIdTerm && query.eventId == null) {
      return empty;
    }

    const and: Record<string, unknown>[] = [];
    if (q) {
      const or = await this.buildConditions(q, field);
      if (!or.length) {
        return empty;
      }
      and.push({ $or: or });
    }
    if (query.eventId != null) {
      and.push({ eventId: query.eventId });
    }
    if (query.status) {
      and.push({ status: query.status });
    }
    if (query.paymentMethod) {
      // Narrowed to the orders of the tickets matched so far, never the whole order base.
      const candidateOrderIds = (await this.ticketModel
        .distinct("orderId", and.length ? { $and: and } : {})
        .exec()) as number[];
      const orderIds = candidateOrderIds.length
        ? ((await this.mockOrderModel
            .distinct("id", {
              id: { $in: candidateOrderIds },
              paymentMethod: query.paymentMethod,
            })
            .exec()) as number[])
        : [];
      if (!orderIds.length) {
        return empty;
      }
      and.push({ orderId: { $in: orderIds } });
    }

    const filter = { $and: and };
    const [total, tickets] = await Promise.all([
      this.ticketModel.countDocuments(filter).exec(),
      this.ticketModel
        .find(filter)
        .sort({ created: -1, id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean()
        .exec() as Promise<ITicket[]>,
    ]);
    if (!tickets.length) {
      return { ...empty, total };
    }

    return { items: await this.hydrate(tickets), total, page, limit };
  }

  /** One `$or` over Ticket fields; a term that resolves to nothing adds no condition. */
  private async buildConditions(
    q: string,
    field: AdminVaultTicketSearchField,
  ): Promise<Record<string, unknown>[]> {
    const conditions: Record<string, unknown>[] = [];
    const add = (condition: Record<string, unknown> | null) => {
      if (condition) {
        conditions.push(condition);
      }
    };
    const compact = q.replace(/\s+/g, "");
    const upper = compact.toUpperCase();
    const numeric = safeInteger(compact);
    const hasLetterAndDigit = /[A-Z]/i.test(compact) && /\d/.test(compact);

    switch (field) {
      case "email":
        add(await this.byCustomers({ email: new RegExp(escapeRegex(q), "i") }));
        break;
      case "code":
        add(this.byCode(upper, false));
        break;
      case "ticketId":
        if (numeric !== null) add({ id: numeric });
        break;
      case "orderId":
        if (numeric !== null) add({ orderId: numeric });
        break;
      case "bookingCode":
        add(await this.byBookingCode(upper));
        break;
      case "name":
        add(await this.byCustomers({ fullname: new RegExp(escapeRegex(q), "i") }));
        break;
      case "phone":
        add(await this.byPhone(q));
        break;
      case "event":
        add(await this.byEventTitle(q));
        break;
      default: {
        if (q.includes("@")) {
          add(await this.byCustomers({ email: new RegExp(escapeRegex(q), "i") }));
        } else if (
          /^TT-?[A-Z0-9]{8}$/i.test(compact) ||
          (/^[A-Z0-9]{8}$/i.test(compact) && hasLetterAndDigit)
        ) {
          add(this.byCode(upper, false));
        } else if (numeric !== null) {
          add({ id: numeric });
          add({ orderId: numeric });
          if (compact.length >= 6) {
            add(await this.byPhone(q));
          }
        } else if (/^[A-Z0-9]{6}$/i.test(compact) && hasLetterAndDigit) {
          add(await this.byBookingCode(upper));
          add(this.byCode(upper, true));
        } else {
          const pattern = new RegExp(escapeRegex(q), "i");
          add(await this.byCustomers({ fullname: pattern }));
          add(await this.byCustomers({ email: pattern }));
          if (compact.length >= 3) {
            add(this.byCode(upper, true));
          }
          add(await this.byEventTitle(q));
          // "+66 81-234 5678": a typed phone with separators.
          if (/^[\d\s()+.-]+$/.test(q) && q.replace(/\D/g, "").length >= 6) {
            add(await this.byPhone(q));
          }
        }
      }
    }
    return conditions;
  }

  /**
   * A full code (with or without `TT-`) matches exactly; anything shorter is a substring,
   * anchored at the start when it begins with the `TT-` prefix.
   */
  private byCode(upper: string, substringOnly: boolean): Record<string, unknown> | null {
    if (!upper) {
      return null;
    }
    if (!substringOnly) {
      const full = /^TT[A-Z0-9]{8}$/.test(upper)
        ? `TT-${upper.slice(2)}`
        : /^[A-Z0-9]{8}$/.test(upper)
          ? `TT-${upper}`
          : upper;
      if (TICKET_CODE_FULL.test(full)) {
        return { code: full };
      }
    }
    const pattern = upper.startsWith("TT-")
      ? new RegExp(`^${escapeRegex(upper)}`)
      : new RegExp(escapeRegex(upper), "i");
    return { code: pattern };
  }

  private async byCustomers(
    match: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    const rows = await this.customerModel
      .find(match)
      .select({ id: 1 })
      .limit(CUSTOMER_MATCH_CAP)
      .lean()
      .exec();
    const ids = (rows as Array<Pick<ICustomer, "id">>).map((c) => c.id);
    return ids.length ? { customer: { $in: ids } } : null;
  }

  /** Phones are stored as typed ("+66 81-234 5678"): digits may be split by separators. */
  private async byPhone(q: string): Promise<Record<string, unknown> | null> {
    const digits = q.replace(/\D/g, "");
    if (digits.length < 3) {
      return null;
    }
    return this.byCustomers({
      phone: new RegExp(digits.split("").join("\\D*")),
    });
  }

  private async byBookingCode(
    upper: string,
  ): Promise<Record<string, unknown> | null> {
    if (!upper) {
      return null;
    }
    const orders = await this.mockOrderModel
      .find({ bookingCode: upper })
      .select({ id: 1 })
      .lean()
      .exec();
    const ids = (orders as Array<Pick<IMockOrder, "id">>).map((o) => o.id);
    return ids.length ? { orderId: { $in: ids } } : null;
  }

  private async byEventTitle(
    q: string,
  ): Promise<Record<string, unknown> | null> {
    const re = new RegExp(escapeRegex(q), "i");
    const ids = (await this.eventModel
      .distinct("id", {
        $or: [{ "title.th": re }, { "title.en": re }, { "title.ru": re }],
      })
      .exec()) as number[];
    return ids.length ? { eventId: { $in: ids } } : null;
  }

  /** Orders, buyers, events, organizers, cancelled shows and scan times — one batch query each. */
  private async hydrate(tickets: ITicket[]): Promise<AdminVaultTicketItem[]> {
    const orderIds = [...new Set(tickets.map((t) => t.orderId))];
    const customerIds = [...new Set(tickets.map((t) => t.customer))];
    const eventIds = [...new Set(tickets.map((t) => t.eventId))];
    const usedTicketIds = tickets
      .filter((t) => t.status === "USED")
      .map((t) => t.id);
    const sessionIds = [
      ...new Set(
        tickets
          .filter((t) => typeof t.session === "number")
          .map((t) => t.session as number),
      ),
    ];

    const [orders, liveCounts, customers, events, sessions, usedScans] =
      await Promise.all([
        this.mockOrderModel
          .find({ id: { $in: orderIds } })
          .select({ refund: 0, refundedTickets: 0 })
          .lean()
          .exec() as Promise<IMockOrder[]>,
        this.ticketModel
          .aggregate<{ _id: number; n: number }>([
            { $match: { orderId: { $in: orderIds } } },
            { $group: { _id: "$orderId", n: { $sum: 1 } } },
          ])
          .exec(),
        this.customerModel
          .find({ id: { $in: customerIds } })
          .select({ id: 1, fullname: 1, email: 1, phone: 1 })
          .lean()
          .exec(),
        this.eventModel
          .find({ id: { $in: eventIds } })
          .select({
            id: 1,
            title: 1,
            status: 1,
            hiddenFromSite: 1,
            archivedByOrganizer: 1,
            eventDate: 1,
            city: 1,
            recurrence: 1,
            creator: 1,
            sectors: 1,
          })
          .lean()
          .exec() as unknown as Promise<VaultEventDoc[]>,
        sessionIds.length
          ? this.sessionModel
              .find({ id: { $in: sessionIds } })
              .select({ id: 1, eventId: 1, date: 1, start: 1, end: 1, status: 1 })
              .lean()
              .exec()
          : Promise.resolve([]),
        usedTicketIds.length
          ? this.scanModel
              .aggregate<{ _id: number; date: Date }>([
                { $match: { id: { $in: usedTicketIds }, status: "used" } },
                { $group: { _id: "$id", date: { $max: "$date" } } },
              ])
              .exec()
          : Promise.resolve([] as Array<{ _id: number; date: Date }>),
      ]);

    const usersById = await this.usersService.findManyByNumericIds(
      events.map((e) => e.creator),
    );

    const orderById = new Map(orders.map((o) => [o.id, o]));
    const liveCountByOrder = new Map(liveCounts.map((r) => [r._id, r.n]));
    const customerById = new Map(
      (
        customers as Array<
          Pick<ICustomer, "id" | "fullname" | "email" | "phone">
        >
      ).map((c) => [c.id, c]),
    );
    const eventById = new Map(events.map((e) => [e.id, e]));
    const namesByEvent = new Map(
      events.map((e) => [e.id, buildSectorZoneNames(e, "en")]),
    );
    const sessionByKey = new Map(
      (
        sessions as Array<
          Pick<IEventSession, "id" | "eventId" | "date" | "start" | "end" | "status">
        >
      ).map((s) => [`${s.eventId}:${s.id}`, s]),
    );
    const usedAtById = new Map(usedScans.map((s) => [s._id, s.date]));

    return tickets.map((ticket): AdminVaultTicketItem => {
      const order = orderById.get(ticket.orderId);
      const customer = customerById.get(ticket.customer);
      const event = eventById.get(ticket.eventId);
      const names = namesByEvent.get(ticket.eventId);
      const session =
        typeof ticket.session === "number"
          ? sessionByKey.get(`${ticket.eventId}:${ticket.session}`)
          : undefined;
      return {
        ticket: {
          id: ticket.id,
          code: ticket.code,
          orderId: ticket.orderId,
          status: ticket.status,
          price: ticket.price,
          currency: ticket.currency,
          sectorId: ticket.sector,
          sectorName: names ? names.sectorName(ticket.sector) : ticket.sector,
          zoneId: ticket.zone,
          zoneName: names
            ? names.zoneName(ticket.sector, ticket.zone)
            : ticket.zone,
          session:
            typeof ticket.session === "number"
              ? {
                  id: ticket.session,
                  date: ticket.sessionDate || session?.date || null,
                  start: ticket.sessionStart || session?.start || null,
                  end: ticket.sessionEnd || session?.end || null,
                  cancelled: session?.status === "cancelled",
                }
              : null,
          createdAt: toIso(ticket.created),
          usedAt: toIso(usedAtById.get(ticket.id)),
        },
        order: order
          ? {
              id: order.id,
              status: order.status,
              refundStatus: order.refundStatus ?? "none",
              paymentMethod: order.paymentMethod ?? null,
              paymentMethodLabel:
                order.paymentMethod === "CASH"
                  ? "CASH"
                  : resolvePaymentMethodLabel(
                      order.paymentCurrency,
                      order.paymentMethod,
                    ),
              paymentCurrency: order.paymentCurrency,
              price: order.price,
              totalPrice: order.total_price,
              vat: order.vat,
              additionalTicketCostFee: order.additionalTicketCostFee,
              bankCardFee: order.bankCardFee ?? null,
              cashFee: order.cashFee ?? null,
              originalPaidAmount: order.originalPaidAmount ?? null,
              promoCodeId: order.promoCodeId ?? null,
              promocodeDiscount: order.promocodeDiscount ?? null,
              lineTicketCount: (order.tickets ?? []).reduce(
                (sum, line) => sum + (line.count ?? 0),
                0,
              ),
              liveTicketCount: liveCountByOrder.get(order.id) ?? 0,
              createdAt: toIso(order.createdAt),
              updatedAt: toIso(order.updatedAt),
              paymentConfirmedAt: toIso(order.paymentConfirmedAt),
              bookingCode: order.bookingCode ?? null,
              cashierEmail: order.cashierEmail ?? null,
              actualPos: order.actualPos ?? null,
              ticketEmailStatus: order.ticketEmailStatus ?? null,
            }
          : null,
        buyer: customer
          ? {
              id: customer.id,
              fullname: customer.fullname?.trim() || null,
              email: customer.email?.trim() || null,
              phone: customer.phone?.trim() || null,
            }
          : null,
        event: event
          ? {
              id: event.id,
              title: event.title,
              status: event.status,
              hiddenFromSite: event.hiddenFromSite === true,
              archivedByOrganizer:
                (event as { archivedByOrganizer?: boolean })
                  .archivedByOrganizer === true,
              eventDate: event.eventDate,
              city: event.city ?? null,
              isRecurring: event.recurrence?.enabled === true,
              creator: event.creator,
              organizerName: this.organizerDisplayName(
                usersById.get(event.creator),
              ),
            }
          : null,
        removable:
          order?.status === "paid" &&
          order.refundStatus !== "refund_in_progress",
      };
    });
  }
}
