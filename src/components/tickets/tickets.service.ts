import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import mongoose from 'mongoose';
import { randomBytes } from 'crypto';
import { TicketSchema, ITicket } from './schemas/ticket.schema';
import { TICKET_STATUS_DEFAULT } from './constants/ticket-status.constant';
import type { IMockOrder } from '../mock-orders/schemas/mock-order.schema';
import { MockOrderSchema } from '../mock-orders/schemas/mock-order.schema';
import { EventSchema, IEvent } from '../events/schemas/event.schema';
import { CustomerSchema, ICustomer } from '../customers/schemas/customer.schema';
import { ManagerSchema, IManager } from '../managers/schemas/manager.schema';
import { ScanSchema, IScan } from './schemas/scan.schema';
import {
  EventSessionSchema,
  IEventSession,
} from '../event-sessions/schemas/event-session.schema';
import {
  CmsPageSchema,
  ICmsPage,
} from '../content-cms/schemas/cms-page.schema';
import {
  CmsAtomicField,
  CmsContentPage,
  CmsLocale,
  CmsRepeaterItem,
} from '../content-cms/types/cms.types';
import { isLocationRepeaterId } from '../content-cms/constants/location-card.constants';
import { venueLabel } from '../events/utils/venue.util';
import { ticketPlacementFields } from '../seat-holds/utils/seat-holds.util';

type CmsLocationPage = Pick<CmsContentPage, 'publication' | 'sections'>;

/** Sessions and event dates are local Thailand wall-clock strings (ICT, UTC+7). */
const ICT_OFFSET_MS = 7 * 60 * 60 * 1000;

/**
 * A ticket may be scanned this many days before/after its show date. The comparison
 * runs entirely in ICT day-strings, so the scanner device's timezone is irrelevant;
 * the one-day slack absorbs midnight-adjacent shows and clock drift.
 */
const SCAN_GRACE_DAYS = 1;

@Injectable()
export class TicketsService {
  private readonly logger = new Logger(TicketsService.name);

  private get ticketModel(): mongoose.Model<ITicket> {
    return (mongoose.models.Ticket as mongoose.Model<ITicket>) ??
      mongoose.model<ITicket>('Ticket', TicketSchema);
  }

  private get eventModel(): mongoose.Model<IEvent> {
    return (mongoose.models.Event as mongoose.Model<IEvent>) ??
      mongoose.model<IEvent>('Event', EventSchema);
  }

  private get customerModel(): mongoose.Model<ICustomer> {
    return (mongoose.models.Customer as mongoose.Model<ICustomer>) ??
      mongoose.model<ICustomer>('Customer', CustomerSchema);
  }

  private get managerModel(): mongoose.Model<IManager> {
    return (mongoose.models.Manager as mongoose.Model<IManager>) ??
      mongoose.model<IManager>('Manager', ManagerSchema);
  }

  private get mockOrderModel(): mongoose.Model<IMockOrder> {
    return (mongoose.models.MockOrder as mongoose.Model<IMockOrder>) ??
      mongoose.model<IMockOrder>('MockOrder', MockOrderSchema);
  }

  private get scanModel(): mongoose.Model<IScan> {
    return (mongoose.models.Scan as mongoose.Model<IScan>) ??
      mongoose.model<IScan>('Scan', ScanSchema);
  }

  private get sessionModel(): mongoose.Model<IEventSession> {
    return (mongoose.models.EventSession as mongoose.Model<IEventSession>) ??
      mongoose.model<IEventSession>('EventSession', EventSessionSchema);
  }

  private get cmsPageModel(): mongoose.Model<ICmsPage> {
    return (mongoose.models.ContentCmsPage as mongoose.Model<ICmsPage>) ??
      mongoose.model<ICmsPage>('ContentCmsPage', CmsPageSchema);
  }

  private normalizeLocationIdentifier(value?: string): string {
    return value?.trim().toLocaleLowerCase() ?? '';
  }

  private getLocalizedFieldValue(field: CmsAtomicField | undefined, locale: CmsLocale): string {
    if (!field) return '';
    if (field.type === 'text' || field.type === 'textarea' || field.type === 'richText') {
      return field.value[locale]?.trim() ||
        field.value.en?.trim() ||
        field.value.ru?.trim() ||
        field.value.th?.trim() ||
        '';
    }
    if (field.type === 'button' || field.type === 'link') {
      return field.url[locale]?.trim() ||
        field.url.en?.trim() ||
        field.url.ru?.trim() ||
        field.url.th?.trim() ||
        '';
    }
    return '';
  }

  private locationMatches(item: CmsRepeaterItem, identifier: string): boolean {
    const titleField = item.fields.find((field) => field.id === 'title');
    const candidates = [
      item.id,
      item.unique_id,
      item.title,
      ...(titleField &&
      (titleField.type === 'text' ||
        titleField.type === 'textarea' ||
        titleField.type === 'richText')
        ? Object.values(titleField.value)
        : []),
    ];
    return candidates.some(
      (candidate) => this.normalizeLocationIdentifier(candidate) === identifier,
    );
  }

  private resolveLocationDetails(
    pages: CmsLocationPage[],
    selectedPos: string | undefined,
    locale: CmsLocale,
  ): {
    latitude: number | null;
    longitude: number | null;
    googleMapsUrl: string | null;
  } | null {
    const identifier = this.normalizeLocationIdentifier(selectedPos);
    if (!identifier) return null;

    for (const page of pages) {
      if (page.publication !== 'published') continue;
      for (const section of page.sections ?? []) {
        if (!section.visible) continue;
        for (const field of section.fields ?? []) {
          if (field.type !== 'repeater' || !isLocationRepeaterId(field.id)) continue;
          const item = field.items.find(
            (candidate) =>
              candidate.showCard !== false &&
              this.locationMatches(candidate, identifier),
          );
          if (!item) continue;

          const latitudeField = item.fields.find((entry) => entry.id === 'latitude');
          const longitudeField = item.fields.find((entry) => entry.id === 'longitude');
          const routeField = item.fields.find((entry) => entry.id === 'routeButtonUrl');
          const latitude =
            latitudeField?.type === 'number' ? Number(latitudeField.value) : Number.NaN;
          const longitude =
            longitudeField?.type === 'number' ? Number(longitudeField.value) : Number.NaN;
          const normalizedLatitude = Number.isFinite(latitude) ? latitude : null;
          const normalizedLongitude = Number.isFinite(longitude) ? longitude : null;
          const configuredUrl = this.getLocalizedFieldValue(routeField, locale);
          const googleMapsUrl =
            configuredUrl ||
            (normalizedLatitude != null && normalizedLongitude != null
              ? `https://www.google.com/maps/search/?api=1&query=${normalizedLatitude},${normalizedLongitude}`
              : null);

          return {
            latitude: normalizedLatitude,
            longitude: normalizedLongitude,
            googleMapsUrl,
          };
        }
      }
    }
    return null;
  }

  private normalizeCode(code: string): string {
    return code.trim().toUpperCase();
  }

  private formatReadableDateTime(value: Date | string): string {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n: number) => String(n).padStart(2, '0');
    const day = pad(d.getDate());
    const month = pad(d.getMonth() + 1);
    const year = d.getFullYear();
    const hours = pad(d.getHours());
    const minutes = pad(d.getMinutes());
    const seconds = pad(d.getSeconds());
    return `${day}.${month}.${year} ${hours}:${minutes}:${seconds}`;
  }

  private logScanAttempt(params: {
    code: string;
    price: number | '';
    scanDate: Date;
    buyerEmail: string;
    eventId: number | '';
  }): void {
    const payload = {
      code: params.code,
      price: params.price,
      scanDate: this.formatReadableDateTime(params.scanDate),
      buyerEmail: params.buyerEmail,
      eventId: params.eventId,
    };
    this.logger.log(`Ticket scan: ${JSON.stringify(payload)}`);
  }

  private async getAuthorizedManager(eventId: number, managerId: number): Promise<IManager> {
    const manager = await this.managerModel
      .findOne({ id: managerId, $or: [{ events: eventId }, { event: eventId }] })
      .lean()
      .exec();
    if (!manager) {
      throw new ForbiddenException('Manager is not allowed to access this event');
    }
    return manager as IManager;
  }

  private generateCodeChunk(length = 8): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const bytes = randomBytes(length);
    let out = '';
    for (let i = 0; i < length; i++) {
      out += chars[bytes[i] % chars.length];
    }
    return out;
  }

  private async generateUniqueTicketCode(): Promise<string> {
    for (let i = 0; i < 20; i++) {
      const code = `TT-${this.generateCodeChunk(8)}`;
      const exists = await this.ticketModel.exists({ code });
      if (!exists) {
        return code;
      }
    }
    throw new Error('Failed to generate unique ticket code');
  }

  /**
   * Internal use only. Creates tickets from paid order positions.
   */
  async createFromOrder(order: IMockOrder): Promise<ITicket[]> {
    const createdTickets: ITicket[] = [];

    for (const item of order.tickets) {
      for (let i = 0; i < item.count; i++) {
        const code = await this.generateUniqueTicketCode();
        const ticket = new this.ticketModel({
          customer: order.customer,
          orderId: order.id,
          eventId: order.event,
          sector: item.sectorId,
          zone: item.zoneId,
          price: item.price,
          currency: item.currency,
          code,
          status: TICKET_STATUS_DEFAULT,
          // The exact show (regular events) and seat (seating plan) it was bought for.
          ...ticketPlacementFields(item, i),
          created: new Date(),
        });
        const saved = await ticket.save();
        createdTickets.push(saved);
      }
    }

    this.logger.log(
      `Created ${createdTickets.length} tickets for orderId=${order.id}`,
    );

    return createdTickets;
  }

  async findById(id: number): Promise<ITicket | null> {
    const row = await this.ticketModel.findOne({ id }).lean().exec();
    return (row as ITicket | null) ?? null;
  }

  async findByOrderForCustomer(orderId: number, customerId: number): Promise<ITicket[]> {
    return this.ticketModel
      .find({ orderId, customer: customerId })
      .sort({ created: 1 })
      .lean()
      .exec() as Promise<ITicket[]>;
  }

  async findAllForCustomer(customerId: number) {
    const [tickets, cashOrders] = await Promise.all([
      this.ticketModel
        .find({ customer: customerId })
        .sort({ created: -1 })
        .lean()
        .exec() as Promise<ITicket[]>,
      this.mockOrderModel
        .find({
          customer: customerId,
          paymentMethod: 'CASH',
          status: { $in: ['pending_cash', 'expired', 'cancelled'] },
        })
        .sort({ createdAt: -1 })
        .lean()
        .exec() as Promise<IMockOrder[]>,
    ]);

    if (!tickets.length && !cashOrders.length) {
      return [];
    }

    const [customer, events, cmsPages] = await Promise.all([
      this.customerModel.findOne({ id: customerId }).lean().exec(),
      this.eventModel
        .find({
          id: {
            $in: Array.from(
              new Set([
                ...tickets.map((ticket) => ticket.eventId),
                ...cashOrders.map((order) => order.event),
              ]),
            ),
          },
        })
        .lean()
        .exec(),
      cashOrders.length
        ? this.cmsPageModel
            .find({ publication: 'published' })
            .lean()
            .exec()
        : Promise.resolve([] as CmsLocationPage[]),
    ]);

    const eventMap = new Map<number, IEvent>((events as IEvent[]).map((event) => [event.id, event]));

    const issuedTickets = tickets.map((ticket) => {
      const event = eventMap.get(ticket.eventId);
      const sector = event?.sectors?.find((item) => item.id === ticket.sector);
      const zone = sector?.zones?.find((item) => item.id === ticket.zone);
      const coverImageId = Number((event as any)?.coverImage);
      /**
       * A ticket for a regular event belongs to one specific show, so it must display
       * that session's date and time rather than the event-level schedule.
       */
      const hasSession = typeof ticket.session === 'number' && !!ticket.sessionDate;
      const ticketEventDate = hasSession
        ? { isRange: false, startDate: ticket.sessionDate as string }
        : (event?.eventDate ?? null);
      const ticketTime = hasSession
        ? {
            allDay: false,
            start: ticket.sessionStart ?? '',
            end: ticket.sessionEnd ?? '',
          }
        : (event?.time ?? null);
      return {
        id: ticket.id,
        code: ticket.code,
        status: ticket.status,
        price: ticket.price,
        currency: ticket.currency,
        created: ticket.created,
        orderId: ticket.orderId,
        eventId: ticket.eventId,
        eventTitle: event?.title ?? { th: '', en: '', ru: '' },
        eventDate: ticketEventDate,
        time: ticketTime,
        session: ticket.session ?? null,
        sessionDate: ticket.sessionDate ?? null,
        sessionStart: ticket.sessionStart ?? null,
        sessionEnd: ticket.sessionEnd ?? null,
        seatLabel: ticket.seatLabel ?? null,
        venue: venueLabel(event?.venue),
        coverImageUrl: Number.isFinite(coverImageId) && coverImageId > 0 ? `/media/${coverImageId}` : '',
        sector: {
          id: ticket.sector,
          name: sector?.name ?? { th: '', en: '', ru: '' },
        },
        zone: {
          id: ticket.zone,
          name: zone?.name ?? { th: '', en: '', ru: '' },
        },
        customer: {
          fullname: customer?.fullname ?? '',
          email: customer?.email ?? '',
          phone: '',
        },
      };
    });

    const cashBookings = cashOrders.map((order) => {
      const event = eventMap.get(order.event);
      const firstTicket = order.tickets?.[0];
      const sector = event?.sectors?.find((item) => item.id === firstTicket?.sectorId);
      const zone = sector?.zones?.find((item) => item.id === firstTicket?.zoneId);
      const coverImageId = Number((event as any)?.coverImage);
      const locale: CmsLocale =
        order.locale === 'ru' || order.locale === 'th' ? order.locale : 'en';
      const location = this.resolveLocationDetails(
        cmsPages,
        order.selectedPos,
        locale,
      );
      return {
        id: order.id,
        code: '',
        status: order.status,
        price: order.total_price,
        currency: order.paymentCurrency,
        created: order.createdAt,
        orderId: order.id,
        eventId: order.event,
        eventTitle: event?.title ?? { th: '', en: '', ru: '' },
        eventDate: event?.eventDate ?? null,
        time: event?.time ?? null,
        venue: venueLabel(event?.venue),
        coverImageUrl: Number.isFinite(coverImageId) && coverImageId > 0 ? `/media/${coverImageId}` : '',
        sector: {
          id: firstTicket?.sectorId ?? '',
          name: sector?.name ?? { th: '', en: '', ru: '' },
        },
        zone: {
          id: firstTicket?.zoneId ?? '',
          name: zone?.name ?? { th: '', en: '', ru: '' },
        },
        customer: {
          fullname: customer?.fullname ?? '',
          email: customer?.email ?? '',
          phone: '',
        },
        paymentMethod: 'CASH',
        selected_pos: order.selectedPos ?? null,
        selected_pos_latitude: location?.latitude ?? null,
        selected_pos_longitude: location?.longitude ?? null,
        selected_pos_google_maps_url: location?.googleMapsUrl ?? null,
        expires_at: order.cashBookingExpiresAt ? new Date(order.cashBookingExpiresAt).toISOString() : null,
        bookingCode: order.bookingCode ?? null,
        qrAvailable: false,
        canCancel: order.status === 'pending_cash',
      };
    });

    return [...issuedTickets, ...cashBookings];
  }

  async getScannerEventStructure(eventId: number, managerId: number) {
    await this.getAuthorizedManager(eventId, managerId);

    const event = await this.eventModel.findOne({ id: eventId }).lean().exec();
    if (!event) {
      throw new NotFoundException('Event not found');
    }

    const [tickets, cancelledSessionIds] = await Promise.all([
      this.ticketModel
        .find({ eventId })
        .sort({ created: 1 })
        .lean()
        .exec() as Promise<Array<ITicket & { _id: unknown }>>,
      this.sessionModel.distinct('id', { eventId, status: 'cancelled' }).exec() as Promise<number[]>,
    ]);
    /*
     * The scanner app checks a ticket against this structure first — offline, or when the
     * network fails, that check is all there is — and it only reads `status`. A ticket of a
     * cancelled show therefore goes out as DECLINED (the stored ticket stays ACTIVE), so the
     * door refuses it even without the server. Takes effect once the scanner re-syncs.
     */
    const cancelledSessions = new Set(cancelledSessionIds);
    const scannerStatus = (ticket: ITicket) =>
      ticket.status === 'ACTIVE' &&
      typeof ticket.session === 'number' &&
      cancelledSessions.has(ticket.session)
        ? 'DECLINED'
        : ticket.status;

    const customerIds = Array.from(new Set(tickets.map((ticket) => ticket.customer)));
    const customers = customerIds.length
      ? await this.customerModel
          .find({ id: { $in: customerIds } })
          .select({ id: 1, fullname: 1, email: 1 })
          .lean()
          .exec()
      : [];
    const customerMap = new Map<number, { fullname: string; email: string; phone: string }>(
      (customers as ICustomer[]).map((customer) => [
        customer.id,
        {
          fullname: customer.fullname,
          email: customer.email,
          phone: '',
        },
      ]),
    );

    const groupedByZone = new Map<string, Array<Record<string, unknown>>>();
    for (const ticket of tickets) {
      const key = `${ticket.sector}::${ticket.zone}`;
      const existing = groupedByZone.get(key) ?? [];
      existing.push({
        _id: (ticket as any)._id,
        customer: ticket.customer,
        orderId: ticket.orderId,
        eventId: ticket.eventId,
        sector: ticket.sector,
        zone: ticket.zone,
        price: ticket.price,
        currency: ticket.currency,
        code: ticket.code,
        status: scannerStatus(ticket),
        created: ticket.created,
        id: ticket.id,
        user: customerMap.get(ticket.customer) ?? {
          fullname: '',
          email: '',
          phone: '',
        },
      });
      groupedByZone.set(key, existing); 
    }

    return (event.sectors ?? []).map((sector) => ({
      id: sector.id,
      color: sector.color,
      name: sector.name,
      zones: (sector.zones ?? []).map((zone) => ({
        id: zone.id,
        name: zone.name,
        tickets: groupedByZone.get(`${sector.id}::${zone.id}`) ?? [],
      })),
    }));
  }

  /** `en → ru → th` pick for denormalising localized names into scan history. */
  private pickTitle(value?: { th?: string; en?: string; ru?: string }): string {
    return (value?.en || value?.ru || value?.th || '').trim();
  }

  /**
   * Everything worth freezing onto a scan-history row about this ticket. The ticket,
   * order or event may change or disappear later — support reads the history as it
   * was at the moment of scanning.
   */
  private ticketScanContext(
    ticket: ITicket,
    customer: ICustomer | null,
    event: IEvent | null,
  ) {
    const sector = (event?.sectors ?? []).find((s) => s.id === ticket.sector);
    const zone = sector?.zones?.find((z) => z.id === ticket.zone);
    return {
      eventId: ticket.eventId,
      eventTitle: this.pickTitle(event?.title),
      orderId: ticket.orderId,
      ...(typeof ticket.session === 'number'
        ? {
            sessionId: ticket.session,
            sessionDate: ticket.sessionDate,
            sessionStart: ticket.sessionStart,
            sessionEnd: ticket.sessionEnd,
          }
        : {}),
      customerId: ticket.customer,
      customerName: customer?.fullname ?? '',
      customerEmail: customer?.email ?? '',
      customerPhone: customer?.phone ?? '',
      price: ticket.price,
      currency: ticket.currency,
      sectorId: ticket.sector,
      sectorName: this.pickTitle(sector?.name),
      zoneId: ticket.zone,
      zoneName: this.pickTitle(zone?.name),
    };
  }

  /** Today as a `YYYY-MM-DD` string in Thailand local time. */
  private todayIct(): string {
    return new Date(Date.now() + ICT_OFFSET_MS).toISOString().slice(0, 10);
  }

  private shiftDay(day: string, days: number): string {
    const d = new Date(`${day}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  private formatDayRu(day: string): string {
    const [y, m, d] = day.split('-');
    return `${d}.${m}.${y}`;
  }

  /**
   * `null` when the ticket may be scanned today, otherwise the refusal message.
   *
   * A ticket for a regular event is valid around its own session date; a one-off
   * ticket around the event's date range. Tickets whose stored dates are missing or
   * malformed pass — better to admit odd legacy data than to lock a paying customer
   * out at the door.
   */
  private scanDateWindowError(
    ticket: Pick<ITicket, 'session' | 'sessionDate'>,
    event: Pick<IEvent, 'eventDate'>,
  ): string | null {
    const isDay = (v: unknown): v is string =>
      typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

    const sessionDay =
      typeof ticket.session === 'number' && isDay(ticket.sessionDate)
        ? ticket.sessionDate
        : null;
    const from = sessionDay ?? (isDay(event.eventDate?.startDate) ? event.eventDate.startDate : null);
    if (!from) return null;
    const to = sessionDay ?? (isDay(event.eventDate?.endDate) ? event.eventDate.endDate : from);

    const lo = this.shiftDay(from, -SCAN_GRACE_DAYS);
    const hi = this.shiftDay(to, SCAN_GRACE_DAYS);
    const today = this.todayIct();
    if (today >= lo && today <= hi) return null;

    const showLabel =
      from === to ? this.formatDayRu(from) : `${this.formatDayRu(from)} – ${this.formatDayRu(to)}`;
    return `Билет на ${showLabel} — сканирование доступно с ${this.formatDayRu(lo)} по ${this.formatDayRu(hi)}`;
  }

  async scanTicketByCode(eventId: number, managerId: number, codeRaw: string) {
    const manager = await this.getAuthorizedManager(eventId, managerId);
    const code = this.normalizeCode(codeRaw);

    const ticket = await this.ticketModel.findOne({ code }).exec();
    const scanDate = new Date();
    if (!ticket) {
      this.logScanAttempt({
        code,
        price: '',
        scanDate,
        buyerEmail: '',
        eventId: '',
      });
      // `id: 0` — the code matched nothing, but the attempt itself is support gold.
      await this.scanModel.create({
        id: 0,
        code,
        status: 'declined',
        moderatorId: manager.id,
        moderatorEmail: manager.email,
        date: scanDate,
        reason: 'not_found',
        message: 'Билет не найден',
        requestedEventId: eventId,
      });
      return {
        eventTitle: { th: '', en: '', ru: '' },
        sector: { th: '', en: '', ru: '' },
        zone: { th: '', en: '', ru: '' },
        customer: '',
        email: '',
        phone: '',
        price: '',
        currency: '',
        status: 'error' as const,
        message: 'Билет не найден',
      };
    }

    if (ticket.eventId !== eventId) {
      const declinedCustomer = await this.customerModel.findOne({ id: ticket.customer }).lean().exec();
      // The ticket's own event, so history shows what it actually belongs to.
      const ticketEvent = (await this.eventModel
        .findOne({ id: ticket.eventId })
        .select({ title: 1, sectors: 1 })
        .lean()
        .exec()) as IEvent | null;
      this.logScanAttempt({
        code: ticket.code,
        price: ticket.price,
        scanDate,
        buyerEmail: declinedCustomer?.email ?? '',
        eventId: ticket.eventId,
      });
      await this.scanModel.create({
        id: ticket.id,
        code: ticket.code,
        status: 'declined',
        moderatorId: manager.id,
        moderatorEmail: manager.email,
        date: scanDate,
        reason: 'wrong_event',
        message: 'Билет относится к другому событию',
        requestedEventId: eventId,
        ...this.ticketScanContext(ticket, declinedCustomer as ICustomer | null, ticketEvent),
      });
      return {
        eventTitle: { th: '', en: '', ru: '' },
        sector: { th: '', en: '', ru: '' },
        zone: { th: '', en: '', ru: '' },
        customer: '',
        email: '',
        phone: '',
        price: String(ticket.price),
        currency: ticket.currency,
        status: 'error' as const,
        message: 'Билет относится к другому событию',
      };
    }

    const event = await this.eventModel.findOne({ id: ticket.eventId }).lean().exec();
    if (!event) {
      throw new NotFoundException('Event not found');
    }
    const customer = await this.customerModel.findOne({ id: ticket.customer }).lean().exec();
    this.logScanAttempt({
      code: ticket.code,
      price: ticket.price,
      scanDate,
      buyerEmail: customer?.email ?? '',
      eventId: ticket.eventId,
    });

    const sector = (event.sectors ?? []).find((s) => s.id === ticket.sector);
    const zone = sector?.zones?.find((z) => z.id === ticket.zone);

    const basePayload = {
      eventTitle: event.title ?? { th: '', en: '', ru: '' },
      sector: sector?.name ?? { th: '', en: '', ru: '' },
      zone: zone?.name ?? { th: '', en: '', ru: '' },
      customer: customer?.fullname ?? '',
      email: customer?.email ?? '',
      phone: customer?.phone ?? '',
      price: String(ticket.price),
      currency: ticket.currency,
    };

    if (ticket.status !== 'ACTIVE') {
      /*
       * "Who actually used it" must come from the `used` row: repeated attempts now
       * write `declined` rows too, and a plain latest-by-date lookup would start
       * reporting the previous failed attempt instead of the activation.
       */
      const lastUsed = await this.scanModel
        .findOne({ id: ticket.id, status: 'used' })
        .sort({ date: -1 })
        .lean()
        .exec();
      const lastScan =
        lastUsed ??
        (await this.scanModel.findOne({ id: ticket.id }).sort({ date: -1 }).lean().exec());

      const message = lastScan
        ? `${lastScan.status === 'used' ? 'Билет уже был использован' : 'Билет был отклонён'} модератором ${lastScan.moderatorEmail}, ${this.formatReadableDateTime(lastScan.date)}`
        : `Билет недоступен для активации. Текущий статус: ${ticket.status}`;

      await this.scanModel.create({
        id: ticket.id,
        code: ticket.code,
        status: 'declined',
        moderatorId: manager.id,
        moderatorEmail: manager.email,
        date: scanDate,
        reason: lastUsed ? 'already_used' : 'not_active',
        message,
        requestedEventId: eventId,
        ...this.ticketScanContext(ticket, customer as ICustomer | null, event),
      });

      return {
        ...basePayload,
        status: 'error' as const,
        message,
      };
    }

    /*
     * A cancelled show admits nobody: its buyers were told the tickets are void. Checked
     * before the date gate, so the door sees the real reason rather than a date message.
     */
    const sessionCancelled =
      typeof ticket.session === 'number' &&
      Boolean(
        await this.sessionModel
          .exists({ eventId: ticket.eventId, id: ticket.session, status: 'cancelled' })
          .exec(),
      );
    if (sessionCancelled) {
      // Russian like every other scanner message (the app shows them verbatim); machines read `reason`.
      const message = 'Сеанс отменён организатором — билет недействителен';
      await this.scanModel.create({
        id: ticket.id,
        code: ticket.code,
        status: 'declined',
        moderatorId: manager.id,
        moderatorEmail: manager.email,
        date: scanDate,
        reason: 'session_cancelled',
        message,
        requestedEventId: eventId,
        ...this.ticketScanContext(ticket, customer as ICustomer | null, event),
      });
      return {
        ...basePayload,
        status: 'error' as const,
        message,
      };
    }

    /*
     * Date gate sits after the ACTIVE check on purpose: an already-used ticket keeps
     * its more specific "already used by …" message even outside the window.
     */
    const dateGateMessage = this.scanDateWindowError(ticket, event);
    if (dateGateMessage) {
      await this.scanModel.create({
        id: ticket.id,
        code: ticket.code,
        status: 'declined',
        moderatorId: manager.id,
        moderatorEmail: manager.email,
        date: scanDate,
        reason: 'date_window',
        message: dateGateMessage,
        requestedEventId: eventId,
        ...this.ticketScanContext(ticket, customer as ICustomer | null, event),
      });
      return {
        ...basePayload,
        status: 'error' as const,
        message: dateGateMessage,
      };
    }

    ticket.status = 'USED';
    await ticket.save();

    await this.scanModel.create({
      id: ticket.id,
      code: ticket.code,
      status: 'used',
      moderatorId: manager.id,
      moderatorEmail: manager.email,
      date: scanDate,
      message: 'билет успешно активирован',
      requestedEventId: eventId,
      ...this.ticketScanContext(ticket, customer as ICustomer | null, event),
    });

    return {
      ...basePayload,
      status: 'ok' as const,
      message: 'билет успешно активирован',
    };
  }
}
