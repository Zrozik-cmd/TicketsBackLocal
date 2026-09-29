import { Injectable, NotFoundException } from '@nestjs/common';
import mongoose from 'mongoose';
import { EventsService } from '../events/events.service';
import { EventSessionsService } from '../event-sessions/event-sessions.service';
import { TicketPuppeteerService } from '../../services/puppeteer/ticket-puppeteer.service';
import type { IEvent } from '../events/schemas/event.schema';
import { ITicket, TicketSchema } from '../tickets/schemas/ticket.schema';
import { IMockOrder, MockOrderSchema } from '../mock-orders/schemas/mock-order.schema';
import { CustomerSchema, ICustomer } from '../customers/schemas/customer.schema';
import { IScan, ScanSchema } from '../tickets/schemas/scan.schema';
import {
  EventSessionSchema,
  IEventSession,
} from '../event-sessions/schemas/event-session.schema';
import {
  isEmptyPeriodScope,
  normalizeSessionPeriodFilter,
  periodLinesQuery,
  periodTicketQuery,
  type SessionPeriodScope,
} from '../events/utils/session-period-filter.util';
import type {
  TicketRegistryItem,
  TicketRegistryLocale,
  TicketRegistryQueryDto,
  TicketRegistryResponse,
  TicketRegistryStatus,
  TicketRegistryStatusFilter,
} from './dto/ticket-registry.dto';
import { buildSectorZoneNames } from './utils/sector-zone-names.util';

const DEFAULT_PAGE_SIZE = 20;

/** Ticket statuses the platform actually writes; the other enum values are never set. */
const LIVE_TICKET_STATUSES = ['ACTIVE', 'USED'];

/** One registry row before hydration — the common shape of a live ticket and a refund snapshot. */
type RegistryRow = {
  source: 'ticket' | 'refund';
  ticketId: number;
  code: string;
  orderId: number;
  customer: number;
  sector: string;
  zone: string;
  price: number;
  currency: string;
  ticketStatus: string;
  session?: number | null;
  sessionDate?: string | null;
  sessionStart?: string | null;
  sessionEnd?: string | null;
  created?: Date | null;
};

type SearchConditions = { live: Record<string, unknown>; refund: Record<string, unknown> };

/** Stages allowed inside `$unionWith` (anything but `$out` / `$merge`). */
type NestedPipelineStage = Exclude<
  mongoose.PipelineStage,
  mongoose.PipelineStage.Out | mongoose.PipelineStage.Merge
>;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The organizer's ticket registry (Events → Statistics → Tickets): every ticket of an
 * event for checks at the entrance, buyer look-ups and telling a forged PDF from a real
 * one.
 *
 * Rows come from two places:
 *   - issued tickets (`ACTIVE` / `USED` Ticket documents);
 *   - refunded tickets: completing a refund deletes the Ticket documents, so they are
 *     read from the snapshot the refund leaves on the order (`refundedTickets`). Orders
 *     refunded before that snapshot existed have nothing to list and are not shown.
 * Both are filtered, sorted (purchase time, then ticket id, newest first) and paged in
 * Mongo; only status `all` needs the two sources, merged with `$unionWith`.
 */
@Injectable()
export class TicketRegistryService {
  constructor(
    private readonly eventsService: EventsService,
    private readonly eventSessionsService: EventSessionsService,
    private readonly ticketPuppeteerService: TicketPuppeteerService,
  ) {}

  private get ticketModel(): mongoose.Model<ITicket> {
    return (mongoose.models.Ticket as mongoose.Model<ITicket>) ??
      mongoose.model<ITicket>('Ticket', TicketSchema);
  }

  private get mockOrderModel(): mongoose.Model<IMockOrder> {
    return (mongoose.models.MockOrder as mongoose.Model<IMockOrder>) ??
      mongoose.model<IMockOrder>('MockOrder', MockOrderSchema);
  }

  private get customerModel(): mongoose.Model<ICustomer> {
    return (mongoose.models.Customer as mongoose.Model<ICustomer>) ??
      mongoose.model<ICustomer>('Customer', CustomerSchema);
  }

  private get scanModel(): mongoose.Model<IScan> {
    return (mongoose.models.Scan as mongoose.Model<IScan>) ??
      mongoose.model<IScan>('Scan', ScanSchema);
  }

  private get sessionModel(): mongoose.Model<IEventSession> {
    return (mongoose.models.EventSession as mongoose.Model<IEventSession>) ??
      mongoose.model<IEventSession>('EventSession', EventSessionSchema);
  }

  async getRegistry(
    eventId: number,
    creatorId: string,
    query: TicketRegistryQueryDto,
  ): Promise<TicketRegistryResponse> {
    const period = normalizeSessionPeriodFilter(query);
    const event = await this.eventsService.findOwnedEventDocument(eventId, creatorId);
    const page = query.page ?? 1;
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const status: TicketRegistryStatusFilter = query.status ?? 'all';
    const locale: TicketRegistryLocale = query.locale ?? 'en';
    const search = query.search?.trim() ?? '';
    const empty: TicketRegistryResponse = { items: [], total: 0, page, limit };

    const [cancelledIds, scope] = await Promise.all([
      this.eventSessionsService.cancelledSessionIds(event.id),
      period ? this.eventSessionsService.resolvePeriodScope(event, period) : null,
    ]);
    if (scope && isEmptyPeriodScope(scope)) return empty;
    if (status === 'cancelled' && !cancelledIds.length) return empty;

    const searchConditions = search ? await this.buildSearchConditions(event.id, search) : null;
    const { rows, total } = await this.findPage({
      eventId: event.id,
      status,
      cancelledIds,
      scope,
      searchConditions,
      skip: (page - 1) * limit,
      limit,
    });
    if (!rows.length) return { ...empty, total };

    return {
      items: await this.hydrate(event, rows, new Set(cancelledIds), locale),
      total,
      page,
      limit,
    };
  }

  /**
   * The ticket as a PDF for the organizer (same design as the e-mailed WebP). Only an
   * issued — `ACTIVE` or `USED` — ticket of this event has one; anything else is a 404.
   */
  async getTicketPdf(
    eventId: number,
    creatorId: string,
    ticketId: number,
    locale: TicketRegistryLocale,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const event = await this.eventsService.findOwnedEventDocument(eventId, creatorId);
    const ticket = (await this.ticketModel
      .findOne({ id: ticketId, eventId: event.id, status: { $in: LIVE_TICKET_STATUSES } })
      .select({ id: 1, code: 1 })
      .lean()
      .exec()) as Pick<ITicket, 'id' | 'code'> | null;
    if (!ticket) {
      throw new NotFoundException('Ticket not found');
    }
    const buffer = await this.ticketPuppeteerService.getTicketPdfBuffer(ticket.id, locale);
    return { buffer, filename: `ticket-${ticket.code}.pdf` };
  }

  /**
   * Search terms: a ticket code (or the scanned barcode, which encodes it) by substring,
   * an exact ticket id or order number, and buyer e-mail / name / phone by substring.
   * Buyers are resolved among this event's own buyers only, so the regex never scans the
   * whole customer base.
   */
  private async buildSearchConditions(eventId: number, search: string): Promise<SearchConditions> {
    const pattern = new RegExp(escapeRegex(search), 'i');
    const numeric =
      /^\d+$/.test(search) && Number.isSafeInteger(Number(search)) ? Number(search) : null;
    const buyerIds = await this.findMatchingBuyerIds(eventId, search, pattern);

    const live: Array<Record<string, unknown>> = [{ code: pattern }];
    const refund: Array<Record<string, unknown>> = [{ 'refundedTickets.code': pattern }];
    if (numeric !== null) {
      live.push({ id: numeric }, { orderId: numeric });
      refund.push({ 'refundedTickets.id': numeric }, { id: numeric });
    }
    if (buyerIds.length) {
      live.push({ customer: { $in: buyerIds } });
      refund.push({ 'refundedTickets.customer': { $in: buyerIds } });
    }
    return { live: { $or: live }, refund: { $or: refund } };
  }

  private async findMatchingBuyerIds(
    eventId: number,
    search: string,
    pattern: RegExp,
  ): Promise<number[]> {
    const [ticketBuyers, refundBuyers] = await Promise.all([
      this.ticketModel.distinct('customer', { eventId }).exec(),
      this.mockOrderModel
        .distinct('refundedTickets.customer', { event: eventId, status: 'refunded' })
        .exec(),
    ]);
    const eventBuyerIds = [...new Set([...ticketBuyers, ...refundBuyers] as number[])];
    if (!eventBuyerIds.length) return [];

    // Phones are stored as typed ("+66 81-234 5678"): let a digits-only search skip separators.
    const digits = search.replace(/\D/g, '');
    const phonePattern =
      /^[\d\s()+.-]+$/.test(search) && digits.length >= 3
        ? new RegExp(digits.split('').join('\\D*'))
        : pattern;
    return (await this.customerModel
      .distinct('id', {
        id: { $in: eventBuyerIds },
        $or: [{ email: pattern }, { fullname: pattern }, { phone: phonePattern }],
      })
      .exec()) as number[];
  }

  private async findPage(params: {
    eventId: number;
    status: TicketRegistryStatusFilter;
    cancelledIds: number[];
    scope: SessionPeriodScope | null;
    searchConditions: SearchConditions | null;
    skip: number;
    limit: number;
  }): Promise<{ rows: RegistryRow[]; total: number }> {
    const { eventId, status, cancelledIds, scope, searchConditions } = params;

    // Live tickets: the status filter maps onto the Ticket status and the session's state.
    const liveConditions: Array<Record<string, unknown>> = [{ eventId }];
    if (status === 'used') {
      liveConditions.push({ status: 'USED' });
    } else if (status === 'active') {
      // `$nin` also keeps session-less (one-off) tickets.
      liveConditions.push({ status: 'ACTIVE', session: { $nin: cancelledIds } });
    } else if (status === 'cancelled') {
      liveConditions.push({ status: 'ACTIVE', session: { $in: cancelledIds } });
    } else {
      liveConditions.push({ status: { $in: LIVE_TICKET_STATUSES } });
    }
    if (scope) liveConditions.push(periodTicketQuery(scope));
    if (searchConditions) liveConditions.push(searchConditions.live);
    const livePipeline: mongoose.PipelineStage[] = [
      { $match: { $and: liveConditions } },
      {
        $project: {
          _id: 0,
          source: { $literal: 'ticket' },
          ticketId: '$id',
          code: '$code',
          orderId: '$orderId',
          customer: '$customer',
          sector: '$sector',
          zone: '$zone',
          price: '$price',
          currency: '$currency',
          ticketStatus: '$status',
          session: '$session',
          sessionDate: '$sessionDate',
          sessionStart: '$sessionStart',
          sessionEnd: '$sessionEnd',
          created: '$created',
        },
      },
    ];

    // Refunded tickets: one row per snapshot entry of a refunded order.
    const orderConditions: Array<Record<string, unknown>> = [
      { event: eventId, status: 'refunded', 'refundedTickets.0': { $exists: true } },
    ];
    const snapshotConditions: Array<Record<string, unknown>> = [];
    if (scope) {
      orderConditions.push(periodLinesQuery(scope, 'refundedTickets'));
      snapshotConditions.push(periodTicketQuery(scope, 'refundedTickets.session'));
    }
    if (searchConditions) snapshotConditions.push(searchConditions.refund);
    const refundPipeline: NestedPipelineStage[] = [
      { $match: { $and: orderConditions } },
      { $unwind: '$refundedTickets' },
      ...(snapshotConditions.length ? [{ $match: { $and: snapshotConditions } }] : []),
      {
        $project: {
          _id: 0,
          source: { $literal: 'refund' },
          ticketId: '$refundedTickets.id',
          code: '$refundedTickets.code',
          orderId: '$id',
          customer: '$refundedTickets.customer',
          sector: '$refundedTickets.sector',
          zone: '$refundedTickets.zone',
          price: '$refundedTickets.price',
          currency: '$refundedTickets.currency',
          ticketStatus: '$refundedTickets.status',
          session: '$refundedTickets.session',
          sessionDate: '$refundedTickets.sessionDate',
          sessionStart: '$refundedTickets.sessionStart',
          sessionEnd: '$refundedTickets.sessionEnd',
          created: '$refundedTickets.created',
        },
      },
    ];

    // Ticket ids are never reused, so (purchase time, id) is a stable total order.
    const pageStages: mongoose.PipelineStage[] = [
      { $sort: { created: -1, ticketId: -1 } },
      {
        $facet: {
          total: [{ $count: 'count' }],
          rows: [{ $skip: params.skip }, { $limit: params.limit }],
        },
      },
    ];
    type PageResult = { total: Array<{ count: number }>; rows: RegistryRow[] };

    let result: PageResult[];
    if (status === 'refunded') {
      result = await this.mockOrderModel
        .aggregate<PageResult>([...refundPipeline, ...pageStages])
        .allowDiskUse(true)
        .exec();
    } else if (status === 'all') {
      result = await this.ticketModel
        .aggregate<PageResult>([
          ...livePipeline,
          {
            $unionWith: {
              coll: this.mockOrderModel.collection.collectionName,
              pipeline: refundPipeline,
            },
          },
          ...pageStages,
        ])
        .allowDiskUse(true)
        .exec();
    } else {
      result = await this.ticketModel
        .aggregate<PageResult>([...livePipeline, ...pageStages])
        .allowDiskUse(true)
        .exec();
    }

    return { rows: result[0]?.rows ?? [], total: result[0]?.total[0]?.count ?? 0 };
  }

  /** Buyers, scan times and (rarely) missing session fields — one batch query each. */
  private async hydrate(
    event: IEvent,
    rows: RegistryRow[],
    cancelled: Set<number>,
    locale: TicketRegistryLocale,
  ): Promise<TicketRegistryItem[]> {
    const customerIds = [...new Set(rows.map((row) => row.customer))];
    const usedTicketIds = rows.filter((row) => row.ticketStatus === 'USED').map((row) => row.ticketId);
    // Tickets always carry their session's date/time; the session is read only if one does not.
    const sessionIdsToLoad = [
      ...new Set(
        rows
          .filter((row) => typeof row.session === 'number' && !row.sessionDate)
          .map((row) => row.session as number),
      ),
    ];

    const [customers, usedScans, sessions] = await Promise.all([
      this.customerModel
        .find({ id: { $in: customerIds } })
        .select({ id: 1, fullname: 1, email: 1, phone: 1 })
        .lean()
        .exec(),
      usedTicketIds.length
        ? this.scanModel
            .aggregate<{ _id: number; date: Date }>([
              { $match: { id: { $in: usedTicketIds }, status: 'used' } },
              { $group: { _id: '$id', date: { $max: '$date' } } },
            ])
            .exec()
        : Promise.resolve([] as Array<{ _id: number; date: Date }>),
      sessionIdsToLoad.length
        ? this.sessionModel
            .find({ eventId: event.id, id: { $in: sessionIdsToLoad } })
            .select({ id: 1, date: 1, start: 1, end: 1 })
            .lean()
            .exec()
        : Promise.resolve([]),
    ]);
    const customerById = new Map(
      (customers as Array<Pick<ICustomer, 'id' | 'fullname' | 'email' | 'phone'>>).map((c) => [c.id, c]),
    );
    const usedAtById = new Map(usedScans.map((scan) => [scan._id, scan.date]));
    const sessionById = new Map(
      (sessions as Array<Pick<IEventSession, 'id' | 'date' | 'start' | 'end'>>).map((s) => [s.id, s]),
    );

    const names = buildSectorZoneNames(event, locale);
    // A one-off ticket is for the event's own date and time (none shown for all-day events).
    const oneOffTime = event.time?.allDay
      ? { start: null, end: null }
      : { start: event.time?.start || null, end: event.time?.end || null };

    return rows.map((row): TicketRegistryItem => {
      const hasSession = typeof row.session === 'number';
      const sessionId = hasSession ? (row.session as number) : null;
      const session = sessionId !== null ? sessionById.get(sessionId) : undefined;
      const customer = customerById.get(row.customer);
      const usedAt = row.ticketStatus === 'USED' ? usedAtById.get(row.ticketId) : undefined;
      return {
        ticketId: row.ticketId,
        code: row.code,
        orderId: row.orderId,
        status: this.registryStatus(row, cancelled),
        buyer: {
          name: customer?.fullname?.trim() || null,
          email: customer?.email?.trim() || null,
          phone: customer?.phone?.trim() || null,
        },
        sectorName: names.sectorName(row.sector),
        zoneName: names.zoneName(row.sector, row.zone),
        price: row.price,
        currency: row.currency,
        sessionId,
        sessionDate: hasSession
          ? (row.sessionDate || session?.date || null)
          : (event.eventDate?.startDate || null),
        sessionStart: hasSession ? (row.sessionStart || session?.start || null) : oneOffTime.start,
        sessionEnd: hasSession ? (row.sessionEnd || session?.end || null) : oneOffTime.end,
        purchasedAt: row.created ? new Date(row.created).toISOString() : null,
        usedAt: usedAt ? new Date(usedAt).toISOString() : null,
        pdfAvailable: row.source === 'ticket',
      };
    });
  }

  private registryStatus(row: RegistryRow, cancelled: Set<number>): TicketRegistryStatus {
    if (row.source === 'refund') return 'refunded';
    if (row.ticketStatus === 'USED') return 'used';
    if (typeof row.session === 'number' && cancelled.has(row.session)) return 'cancelled';
    return 'active';
  }
}
