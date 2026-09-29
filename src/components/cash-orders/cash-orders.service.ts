import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { randomBytes } from 'crypto';
import mongoose from 'mongoose';
import { NotificationService } from '../../services/NotificationService/notification.service';
import { CashEncashmentsService } from '../cash-encashments/cash-encashments.service';
import { CustomerSchema, ICustomer } from '../customers/schemas/customer.schema';
import { EventSchema, IEvent, IZone } from '../events/schemas/event.schema';
import { isSalesClosed } from '../events/constants/event-status.constant';
import {
  EVENT_HIDDEN_ERROR,
  isHiddenFromSite,
} from '../events/constants/event-visibility.constant';
import {
  eventFeeRatesFromPercents,
  resolveEventFeePercents,
} from '../events/utils/event-fee.util';
import { EventSessionsService } from '../event-sessions/event-sessions.service';
import { MockOrdersService } from '../mock-orders/mock-orders.service';
import { EventMessengersNotifierService } from '../event-messengers/services/event-messengers-notifier.service';
import {
  IMockOrder,
  IMockOrderTicket,
  MockOrderSchema,
} from '../mock-orders/schemas/mock-order.schema';
import { PromocodesService } from '../promocodes/promocodes.service';
import { isLocationRepeaterId } from '../content-cms/constants/location-card.constants';
import { CmsPageSchema, ICmsPage } from '../content-cms/schemas/cms-page.schema';
import { CmsRepeaterItem } from '../content-cms/types/cms.types';
import { TicketSchema, ITicket } from '../tickets/schemas/ticket.schema';
import { TicketsService } from '../tickets/tickets.service';
import { BookCashOrderDto } from './dto/book-cash-order.dto';
import { CashOrdersQueryDto } from './dto/cash-orders-query.dto';
import { CashOrdersActor } from './guards/cash-orders-access.guard';
import {
  CASH_BOOKING_EMAIL_LOCALES,
  CashBookingEmailLocale,
} from './locales/cash-booking-email.locales';
import { venueOneLine } from '../events/utils/venue.util';
import {
  ictWallClockToInstant,
  isEventSalesEnded,
  oneTimeEventLastDayStartInstant,
} from '../events/utils/sales-cutoff.util';
import { buildBrandedEmailHtml, emailDetailRow } from '../../utils/branded-email.util';
import { applyPromoDiscount } from '../mock-orders/utils/promo-discount.util';
import { claimOrderSeats, prepareOrderSeats } from '../seat-holds/seat-holds';
import { attachSeatsToLines, lineSeatsOf } from '../seat-holds/utils/seat-holds.util';

const CASH_BOOKING_TTL_MS = 60 * 60 * 1000;

/**
 * Бронь за наличные закрывается за час до начала: иначе клиент не успеет
 * доехать до точки и оплатить, а места час простоят занятыми. Правило только
 * для НОВЫХ броней — уже созданную `pending_cash` бронь касса подтверждает как
 * обычно; карта / QR / крипта / Alipay этим не ограничены.
 */
export const CASH_BOOKING_CUTOFF_MS = 60 * 60 * 1000;

/**
 * Закрыта ли бронь за наличные для этого набора строк на момент `now`.
 * Разовое мероприятие — старт его ПОСЛЕДНЕГО дня: у однодневного это
 * `eventDate.startDate`, у диапазона дат — `eventDate.endDate`; время то же, что
 * у отсечки продаж, — `time.start`, `00:00` для события на весь день
 * (`oneTimeEventLastDayStartInstant`). Многодневная выставка продаётся картой
 * весь срок, и наличные не должны закрываться за час до ПЕРВОГО дня на все
 * оставшиеся. Регулярное — старт сеанса каждой строки.
 * Достаточно одного показа, до которого меньше часа (или уже начавшегося).
 * Битые дата/время бронь не блокируют — так же, как в `sales-cutoff.util`.
 */
export function isCashBookingClosed(
  event: Parameters<typeof oneTimeEventLastDayStartInstant>[0],
  lines: ReadonlyArray<Pick<IMockOrderTicket, 'sessionDate' | 'sessionStart'>>,
  now: number = Date.now(),
): boolean {
  const starts =
    event.recurrence?.enabled === true
      ? lines.map((line) => ictWallClockToInstant(line.sessionDate, line.sessionStart))
      : [oneTimeEventLastDayStartInstant(event)];
  return starts.some((start) => !Number.isNaN(start) && now >= start - CASH_BOOKING_CUTOFF_MS);
}

/**
 * A booking that is no longer live but may be brought back: it either ran out
 * of time or was voided at the till. Restoring one is never automatic — the
 * seats it used to hold are back on sale, so availability is re-checked first.
 */
const RESTORABLE_CASH_STATUSES = ['expired', 'cancelled'] as const;

@Injectable()
export class CashOrdersService {
  private readonly logger = new Logger(CashOrdersService.name);

  constructor(
    private readonly ticketsService: TicketsService,
    private readonly mockOrdersService: MockOrdersService,
    private readonly promocodesService: PromocodesService,
    private readonly notificationService: NotificationService,
    private readonly eventSessionsService: EventSessionsService,
    private readonly config: ConfigService,
    private readonly cashEncashmentsService: CashEncashmentsService,
    private readonly messengersNotifier: EventMessengersNotifierService,
  ) {}

  /** True when the event runs on a repeating schedule instead of a single date. */
  private isRecurring(event: Pick<IEvent, 'recurrence'>): boolean {
    return event.recurrence?.enabled === true;
  }

  private get mockOrderModel(): mongoose.Model<IMockOrder> {
    return (
      (mongoose.models.MockOrder as mongoose.Model<IMockOrder>) ??
      mongoose.model<IMockOrder>('MockOrder', MockOrderSchema)
    );
  }

  private get eventModel(): mongoose.Model<IEvent> {
    return (
      (mongoose.models.Event as mongoose.Model<IEvent>) ??
      mongoose.model<IEvent>('Event', EventSchema)
    );
  }

  private get customerModel(): mongoose.Model<ICustomer> {
    return (
      (mongoose.models.Customer as mongoose.Model<ICustomer>) ??
      mongoose.model<ICustomer>('Customer', CustomerSchema)
    );
  }

  private get ticketModel(): mongoose.Model<ITicket> {
    return (
      (mongoose.models.Ticket as mongoose.Model<ITicket>) ??
      mongoose.model<ITicket>('Ticket', TicketSchema)
    );
  }

  private async generateUniqueMockOrderId(): Promise<number> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = Date.now();
      const exists = await this.mockOrderModel.exists({ id });
      if (!exists) {
        return id;
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new BadRequestException('failed_to_generate_order_id');
  }

  private zoneKey(sectorId: string, zoneId: string): string {
    return `${sectorId}::${zoneId}`;
  }

  private resolveLocale(raw?: string): CashBookingEmailLocale {
    if (raw === 'ru' || raw === 'th' || raw === 'en') {
      return raw;
    }
    return 'en';
  }

  private pickLocalizedText(
    value: { th?: string; en?: string; ru?: string } | undefined,
    locale: CashBookingEmailLocale,
    fallback = '',
  ): string {
    const order: CashBookingEmailLocale[] =
      locale === 'ru' ? ['ru', 'en', 'th'] : locale === 'th' ? ['th', 'en', 'ru'] : ['en', 'ru', 'th'];
    for (const key of order) {
      const text = value?.[key];
      if (typeof text === 'string' && text.trim()) {
        return text.trim();
      }
    }
    return fallback;
  }

  private getTicketPublicBaseUrl(): string {
    const configured = this.config.get<string>('TICKETS_PUBLIC_BASE_URL', '').trim();
    return configured.replace(/\/+$/, '');
  }

  private formatExpiresAt(date: Date, locale: CashBookingEmailLocale): string {
    const localeTag = locale === 'th' ? 'th-TH' : locale === 'ru' ? 'ru-RU' : 'en-GB';
    return date.toLocaleString(localeTag, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'Asia/Bangkok',
    });
  }

  /** Public booking reference shown in customer emails (last 6 digits of order id). */
  private formatBookingNumber(orderId: number | string): string {
    return String(orderId).slice(-6);
  }

  /** What every email and screen shows as the booking number: the code, with
   *  the pre-code order-id tail as a fallback for bookings that predate it. */
  private bookingNumberOf(order: IMockOrder): string {
    return order.bookingCode ?? this.formatBookingNumber(order.id);
  }

  /**
   * Codes are read over a counter and typed on a phone, so the alphabet drops
   * everything that misreads aloud or in print: 0/O, 1/I/L, 8/B, 5/S, 2/Z.
   */
  private static readonly BOOKING_CODE_ALPHABET = 'ACDEFGHJKMNPQRTUVWXY34679';

  private generateBookingCodeCandidate(length = 6): string {
    const alphabet = CashOrdersService.BOOKING_CODE_ALPHABET;
    const bytes = randomBytes(length);
    let out = '';
    for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
    return out;
  }

  private async generateUniqueBookingCode(): Promise<string> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const code = this.generateBookingCodeCandidate();
      const exists = await this.mockOrderModel.exists({ bookingCode: code });
      if (!exists) return code;
    }
    throw new Error('Failed to generate a unique booking code');
  }

  /**
   * Booking lookup for the till: the cashier scans the customer's QR or types
   * the code by hand. Accepts the `bookingCode`, a full numeric order id, and —
   * for bookings created before codes existed — the 6-digit "booking number"
   * from the old emails (the tail of the order id), matched only against still
   * pending bookings and only when it is unambiguous.
   */
  async findCashOrderByCode(
    rawCode: string,
    actor?: CashOrdersActor,
    source: 'scan' | 'manual' = 'scan',
  ) {
    const code = (rawCode ?? '').trim().toUpperCase().replace(/^(LB|BK)[-:]/, '');
    if (!code) throw new NotFoundException('cash_order_not_found');

    let order = (await this.mockOrderModel
      .findOne({ paymentMethod: 'CASH', bookingCode: code })
      .lean()
      .exec()) as IMockOrder | null;

    if (!order && /^[0-9]+$/.test(code)) {
      if (code.length > 6) {
        order = (await this.mockOrderModel
          .findOne({ paymentMethod: 'CASH', id: Number(code) })
          .lean()
          .exec()) as IMockOrder | null;
      } else {
        const pending = (await this.mockOrderModel
          .find({ paymentMethod: 'CASH', status: 'pending_cash' })
          .lean()
          .exec()) as IMockOrder[];
        const matches = pending.filter((candidate) => String(candidate.id).endsWith(code));
        if (matches.length === 1) order = matches[0];
      }
    }

    if (!order) {
      // Ненайденный код — тоже событие: кассир искал и не нашёл.
      if (actor) await this.cashEncashmentsService.recordScan({ actor, code, source, order: null });
      throw new NotFoundException('cash_order_not_found');
    }
    const [customer, event] = await Promise.all([
      this.loadCustomer(order.customer),
      this.loadEvent(order.event),
    ]);

    if (actor) {
      await this.cashEncashmentsService.recordScan({
        actor,
        code,
        source,
        order: {
          id: order.id,
          bookingCode: order.bookingCode ?? null,
          eventId: order.event,
          eventTitle: event.title,
          ticketsCount: (order.tickets ?? []).reduce((sum, line) => sum + (line.count ?? 0), 0),
          amount: order.total_price,
          currency: order.paymentCurrency,
          status: order.status,
        },
      });
    }

    return this.mapCashOrderDetails(order, customer, event);
  }

  private async loadEvent(eventId: number): Promise<IEvent> {
    const event = await this.eventModel.findOne({ id: eventId }).lean().exec();
    if (!event) {
      throw new NotFoundException('event_not_found');
    }
    return event as IEvent;
  }

  private async loadCustomer(customerId: number): Promise<ICustomer> {
    const customer = await this.customerModel.findOne({ id: customerId }).lean().exec();
    if (!customer) {
      throw new NotFoundException('customer_not_found');
    }
    return customer as ICustomer;
  }

  private async buildOrderTicketsAndPrice(
    event: IEvent,
    dto: BookCashOrderDto,
    customerId: number,
  ): Promise<{
    tickets: IMockOrderTicket[];
    price: number;
    totalPrice: number;
    vat: number;
    additionalTicketCostFee: number;
    cashFee: number;
    promoCodeId?: string;
    promoTicketCount?: number;
    promocodeDiscount?: number;
  }> {
    const tickets: IMockOrderTicket[] = [];
    let priceBeforePromo = 0;
    let ticketCount = 0;

    /**
     * A regular event sells each show separately, so a cash booking must name the
     * session too — otherwise the issued ticket falls back to the event-level date
     * and prints the wrong day.
     */
    const recurring = this.isRecurring(event);
    const sessionsById = new Map<number, { id: number; date: string; start: string; end: string }>();
    if (recurring) {
      // On sale right now only — the same shared rule as card checkout.
      const sessions = await this.eventSessionsService.getSessionsWithAvailability(event.id, {
        purchasableOnly: true,
      });
      for (const session of sessions) sessionsById.set(session.id, session);
    }

    for (const item of dto.tickets ?? []) {
      const sector = event.sectors?.find((candidate) => candidate.id === item.sectorId);
      if (!sector) {
        throw new BadRequestException('sector_not_found');
      }
      const zone = sector.zones?.find((candidate: IZone) => candidate.id === item.zoneId);
      if (!zone) {
        throw new BadRequestException('zone_not_found');
      }
      const count = Number(item.count);
      if (!Number.isInteger(count) || count < 1) {
        throw new BadRequestException('invalid_ticket_count');
      }

      let session: { id: number; date: string; start: string; end: string } | undefined;
      if (recurring) {
        if (typeof item.session !== 'number') {
          throw new BadRequestException('session_required');
        }
        session = sessionsById.get(item.session);
        if (!session) {
          throw await this.eventSessionsService.sessionUnavailableError(
            event.id,
            item.session,
            'session_not_available',
          );
        }
      }

      const linePrice = zone.isFree ? 0 : zone.price;
      priceBeforePromo += linePrice * count;
      ticketCount += count;
      tickets.push({
        sectorId: item.sectorId,
        zoneId: item.zoneId,
        price: linePrice,
        currency: zone.currency ?? 'THB',
        count,
        // Denormalised so the printed ticket keeps its show even if the schedule moves.
        ...(session
          ? {
              session: session.id,
              sessionDate: session.date,
              sessionStart: session.start,
              sessionEnd: session.end,
            }
          : {}),
      });
    }
    if (!tickets.length) {
      throw new BadRequestException('tickets_required');
    }

    const trimmedPromo = dto.promoCode?.trim();
    const promoCheck = trimmedPromo
      ? await this.promocodesService.checkPromoCodeForTicket(
          {
            code: trimmedPromo,
            eventId: dto.event,
            ticketCount,
          },
          customerId,
        )
      : null;

    const price = promoCheck
      ? applyPromoDiscount(
          priceBeforePromo,
          promoCheck.discountType,
          promoCheck.discountValue,
        )
      : priceBeforePromo;
    const promocodeDiscount = promoCheck
      ? Math.round((priceBeforePromo - price) * 100) / 100
      : undefined;

    const { vatRate, additionalTicketCostFeeRate, cashFeeRate } = eventFeeRatesFromPercents(
      resolveEventFeePercents(event),
    );
    const vat = Math.round(price * vatRate * 100) / 100;
    const additionalTicketCostFee = Math.round(price * additionalTicketCostFeeRate * 100) / 100;
    const totalBeforeCashFee = Math.round((price + vat + additionalTicketCostFee) * 100) / 100;
    /*
     * Сервисная комиссия за наличные: процент от суммы с НДС, сверху — тот же
     * принцип, что у карточной надбавки. Лежит внутри total_price, поэтому
     * автоматически попадает в кассу кассира и в сверку инкассаций.
     */
    const cashFee = Math.round(totalBeforeCashFee * cashFeeRate * 100) / 100;
    const totalPrice = Math.round((totalBeforeCashFee + cashFee) * 100) / 100;
    return {
      tickets,
      price,
      totalPrice,
      vat,
      additionalTicketCostFee,
      cashFee,
      ...(promoCheck
        ? {
            promoCodeId: promoCheck.promoCodeId,
            promoTicketCount: ticketCount,
            promocodeDiscount,
          }
        : {}),
    };
  }

  private async assertTicketsAvailable(event: IEvent, requestedTickets: IMockOrderTicket[]): Promise<void> {
    /**
     * A regular event sells its zone capacity once per session, so availability has to
     * be judged per session — a seat taken on the 15th must not shrink the 16th.
     */
    if (this.isRecurring(event)) {
      const sessions = await this.eventSessionsService.getSessionsWithAvailability(event.id, {
        purchasableOnly: true,
      });
      const byId = new Map(sessions.map((session) => [session.id, session]));
      /** Seats already claimed by earlier lines of this same booking. */
      const claimed = new Map<string, number>();
      for (const requested of requestedTickets) {
        const session = typeof requested.session === 'number' ? byId.get(requested.session) : undefined;
        if (!session) {
          throw await this.eventSessionsService.sessionUnavailableError(
            event.id,
            requested.session,
            'session_not_available',
          );
        }
        const zone = session.zones.find(
          (candidate) =>
            candidate.sectorId === requested.sectorId && candidate.zoneId === requested.zoneId,
        );
        const key = `${session.id}::${requested.sectorId}::${requested.zoneId}`;
        const alreadyClaimed = claimed.get(key) ?? 0;
        const remaining = (zone?.remaining ?? 0) - alreadyClaimed;
        if (requested.count > remaining) {
          throw new BadRequestException('tickets_not_available');
        }
        claimed.set(key, alreadyClaimed + requested.count);
      }
      return;
    }

    const [reservedOrders, boughtTickets] = await Promise.all([
      this.mockOrderModel
        .find({ event: event.id, status: { $in: ['wait', 'pending_cash'] } })
        .select({ tickets: 1 })
        .lean()
        .exec(),
      this.ticketModel
        .find({ eventId: event.id })
        .select({ sector: 1, zone: 1 })
        .lean()
        .exec(),
    ]);
    const used = new Map<string, number>();
    for (const order of reservedOrders as Array<Pick<IMockOrder, 'tickets'>>) {
      for (const ticket of order.tickets ?? []) {
        const key = this.zoneKey(ticket.sectorId, ticket.zoneId);
        used.set(key, (used.get(key) ?? 0) + (ticket.count ?? 0));
      }
    }
    for (const ticket of boughtTickets as Array<Pick<ITicket, 'sector' | 'zone'>>) {
      const key = this.zoneKey(ticket.sector, ticket.zone);
      used.set(key, (used.get(key) ?? 0) + 1);
    }
    for (const requested of requestedTickets) {
      const sector = event.sectors?.find((candidate) => candidate.id === requested.sectorId);
      const zone = sector?.zones?.find((candidate) => candidate.id === requested.zoneId);
      const key = this.zoneKey(requested.sectorId, requested.zoneId);
      const remaining = Math.max(0, (zone?.seats ?? 0) - (used.get(key) ?? 0));
      if (requested.count > remaining) {
        throw new BadRequestException('tickets_not_available');
      }
    }
  }

  async bookCashOrder(dto: BookCashOrderDto, customerId: number) {
    const event = await this.loadEvent(dto.event);
    // Hidden from the site by the organizer: no new booking, even from a page left open.
    if (isHiddenFromSite(event)) {
      throw new BadRequestException(EVENT_HIDDEN_ERROR);
    }
    // Same server-side barrier as card checkout, from the same shared predicate:
    // a page opened before the event was paused / sent back to moderation can
    // still post a booking, and this is where it must be refused.
    if (isSalesClosed(event)) {
      throw new BadRequestException('Ticket sales for this event are closed.');
    }
    // One-off event past its "stop sales X hours/days before" cut-off.
    if (isEventSalesEnded(event)) {
      throw new BadRequestException('Ticket sales for this event are closed.');
    }
    if (event.paymentOptions?.cashEnabled !== true) {
      throw new BadRequestException('cash_payment_not_enabled');
    }
    const customer = await this.loadCustomer(customerId);
    const pricing = await this.buildOrderTicketsAndPrice(event, dto, customerId);
    // Меньше часа до начала любого показа из брони — наличными уже не бронируем
    // (строки нужны уже разобранными: у регулярного события старт — у сеанса).
    if (isCashBookingClosed(event, pricing.tickets)) {
      throw new BadRequestException('cash_booking_closed');
    }
    await this.assertTicketsAvailable(event, pricing.tickets);
    const seats = await prepareOrderSeats(dto.event, dto.tickets);
    const expiresAt = new Date(Date.now() + CASH_BOOKING_TTL_MS);
    const bookingCode = await this.generateUniqueBookingCode();
    const order = await new this.mockOrderModel({
      id: await this.generateUniqueMockOrderId(),
      bookingCode,
      event: dto.event,
      customer: customerId,
      paymentCurrency: 'THB',
      paymentMethod: 'CASH',
      locale: dto.locale ?? 'en',
      price: pricing.price,
      total_price: pricing.totalPrice,
      vat: pricing.vat,
      additionalTicketCostFee: pricing.additionalTicketCostFee,
      cashFee: pricing.cashFee,
      originalPaidAmount: pricing.totalPrice,
      status: 'pending_cash',
      tickets: attachSeatsToLines(pricing.tickets, seats),
      selectedPos: dto.selected_pos.trim(),
      cashBookingExpiresAt: expiresAt,
      ...(pricing.promoCodeId && pricing.promoTicketCount != null
        ? {
            promoCodeId: pricing.promoCodeId,
            promoTicketCount: pricing.promoTicketCount,
            promocodeDiscount: pricing.promocodeDiscount,
          }
        : {}),
    }).save();
    // Места увели между проверкой и записью — бронь закрывается, не дойдя до письма
    await claimOrderSeats(order.id, seats, () =>
      this.mockOrderModel.updateOne({ id: order.id, status: 'pending_cash' }, { $set: { status: 'cancelled', cancelledBy: 'system', cancelledAt: new Date() } }),
    );
    await this.sendCashBookingEmail(order, customer, event);
    return this.mapCashOrderDetails(order, customer, event);
  }

  async cancelCashOrder(orderId: number, customerId: number) {
    const order = await this.mockOrderModel.findOne({ id: orderId }).exec();
    if (!order) {
      throw new NotFoundException('cash_order_not_found');
    }
    if (order.customer !== customerId) {
      throw new BadRequestException('cash_order_customer_mismatch');
    }
    if (order.paymentMethod !== 'CASH' || order.status !== 'pending_cash') {
      throw new BadRequestException('cash_order_cannot_be_cancelled');
    }
    order.status = 'cancelled';
    order.cancelledBy = 'customer';
    order.cancelledAt = new Date();
    await order.save();
    try {
      const [customer, event] = await Promise.all([
        this.loadCustomer(order.customer),
        this.loadEvent(order.event),
      ]);
      await this.sendCashCancelledEmail(order, customer, event);
    } catch (error) {
      this.logger.warn(
        `Cash booking cancellation email failed for order ${order.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return { id: order.id, status: order.status };
  }

  /**
   * Cancel from the till ("Отменить бронь" on the scanner screen). Unlike the
   * customer's own cancel there is no ownership check — the guard already
   * proved the caller is an admin or cashier — but only a pending booking may
   * be cancelled, so a paid order can never be voided from here.
   */
  async cancelCashOrderByStaff(orderId: number, actor: CashOrdersActor) {
    const order = await this.mockOrderModel.findOne({ id: orderId }).exec();
    if (!order) {
      throw new NotFoundException('cash_order_not_found');
    }
    if (order.paymentMethod !== 'CASH' || order.status !== 'pending_cash') {
      throw new BadRequestException('cash_order_cannot_be_cancelled');
    }
    order.status = 'cancelled';
    order.cancelledBy = actor.type === 'CashierArbi' ? actor.email : 'admin';
    order.cancelledPos =
      actor.type === 'CashierArbi' ? actor.pos_location : order.selectedPos ?? 'Admin';
    order.cancelledAt = new Date();
    await order.save();
    try {
      const [customer, event] = await Promise.all([
        this.loadCustomer(order.customer),
        this.loadEvent(order.event),
      ]);
      await this.sendCashCancelledEmail(order, customer, event);
    } catch (error) {
      this.logger.warn(
        `Cash booking cancellation email failed for order ${order.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    this.logger.log(`Cash order ${order.id} cancelled by ${order.cancelledBy}`);
    return { id: order.id, status: order.status };
  }

  async listCashOrders(query: CashOrdersQueryDto, actor?: CashOrdersActor) {
    const page = query.page != null && query.page >= 1 ? query.page : 1;
    const limit = query.limit != null && query.limit >= 1 && query.limit <= 1000 ? query.limit : 20;
    const skip = (page - 1) * limit;
    const filter = await this.buildCashOrdersFilter(query, actor);
    if (filter == null) {
      return { page, limit, total: 0, totalPages: 0, rows: [] };
    }
    const [total, orders] = await Promise.all([
      this.mockOrderModel.countDocuments(filter).exec(),
      this.mockOrderModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean()
        .exec(),
    ]);
    const rows = await this.mapCashOrderRows(orders as IMockOrder[]);
    return {
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
      rows,
    };
  }

  async getCashOrderDetails(orderId: number) {
    const order = await this.mockOrderModel
      .findOne({
        id: orderId,
        paymentMethod: 'CASH',
        status: { $in: ['pending_cash', 'paid', 'expired', 'cancelled'] },
      })
      .lean()
      .exec();
    if (!order) {
      throw new NotFoundException('cash_order_not_found');
    }
    const [customer, event] = await Promise.all([
      this.loadCustomer(order.customer),
      this.loadEvent(order.event),
    ]);
    return this.mapCashOrderDetails(order as IMockOrder, customer, event);
  }

  private async activateExpiredOrderReservation(order: IMockOrder, event: IEvent): Promise<void> {
    // A restore is a fresh sale of the same seats, so the sales cut-off applies too
    // (per session for a regular event — checked inside `assertTicketsAvailable`).
    if (isEventSalesEnded(event)) {
      throw new BadRequestException('Ticket sales for this event are closed.');
    }
    // Throws `tickets_not_available` when the seats have since been sold, which
    // is the whole point: a restore must never hand out someone else's seats.
    await this.assertTicketsAvailable(event, order.tickets ?? []);
    // Места схемы этой брони — снова за ней; их успели занять другие — восстановить нельзя
    await claimOrderSeats(order.id, lineSeatsOf(order.tickets ?? []));
    order.status = 'pending_cash';
    order.cashBookingExpiresAt = new Date(Date.now() + CASH_BOOKING_TTL_MS);
    order.cancelledBy = undefined;
    order.cancelledAt = undefined;
    order.cancelledPos = undefined;
  }

  private async finalizeCashOrderAsPaid(
    order: IMockOrder,
    actor: CashOrdersActor,
    forcedPosLocation?: string,
    forcedCashierEmail?: string,
  ): Promise<void> {
    /*
     * The organizer cancelled a show this booking is for: taking the cash now would
     * issue tickets the scanner declines. Refused before any money or ticket moves.
     */
    const sessionIds = (order.tickets ?? [])
      .map((line) => line.session)
      .filter((session): session is number => typeof session === 'number');
    if (await this.eventSessionsService.hasCancelledSession(order.event, sessionIds)) {
      throw new BadRequestException('session_cancelled');
    }
    const posLocation =
      forcedPosLocation ?? (actor.type === 'CashierArbi' ? actor.pos_location : order.selectedPos ?? 'Admin');
    const cashierEmail = forcedCashierEmail ?? (actor.type === 'CashierArbi' ? actor.email : 'admin');
    const cashierId = actor.type === 'CashierArbi' ? Number(actor.cashierId) : 0;
    await this.ticketsService.createFromOrder(order);
    order.status = 'paid';
    order.actualPos = posLocation;
    order.cashierEmail = cashierEmail;
    order.cashierId = cashierId;
    order.paymentConfirmedAt = new Date();
    order.ticketEmailStatus = 'pending';
    order.ticketEmailAttempts = 0;
    order.ticketEmailLastError = '';
    order.ticketEmailNextRetryAt = new Date();
    await order.save();

    // Продажа — строка журнала; касса считается только из журнала.
    await this.cashEncashmentsService.recordSale(order, cashierId, cashierEmail);

    // Event group chat (LINE): "New ticket sale", then the sales recheck (sold out).
    void this.messengersNotifier.notifyOrderPaid(order.id).catch((error) => {
      this.logger.warn(
        `Messenger sale notification failed for cash order ${order.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });

    if (order.promoCodeId && order.promoTicketCount) {
      try {
        await this.promocodesService.incrementCustomerPromoUsage(
          order.customer,
          order.promoCodeId,
          order.promoTicketCount,
        );
      } catch (error) {
        this.logger.error(
          `Promo usage increment failed for cash order ${order.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    /*
     * The money is taken and the tickets exist by this point, so a mail outage
     * must not fail the cashier's request — they would read it as "payment not
     * confirmed" and try again on an order that is already paid. The send marks
     * the order's email as failed on its way out, and the per-minute retry cron
     * (`retryFailedTicketEmails`) delivers it.
     */
    try {
      await this.mockOrdersService.resendTicketsEmail(order.id, order.customer, order.locale);
    } catch (error) {
      this.logger.warn(
        `Tickets email for cash order ${order.id} failed, queued for retry: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async confirmCashOrder(orderId: number, actor: CashOrdersActor) {
    const order = await this.mockOrderModel.findOne({ id: orderId, paymentMethod: 'CASH' }).exec();
    if (!order) {
      throw new NotFoundException('cash_order_not_found');
    }
    if (order.status !== 'pending_cash') {
      throw new BadRequestException('cash_order_not_pending');
    }
    await this.finalizeCashOrderAsPaid(order, actor);
    return this.getCashOrderDetails(order.id);
  }

  async extendExpiredCashOrder(orderId: number, actor: CashOrdersActor) {
    const order = await this.mockOrderModel.findOne({ id: orderId, paymentMethod: 'CASH' }).exec();
    if (!order) {
      throw new NotFoundException('cash_order_not_found');
    }
    if (!RESTORABLE_CASH_STATUSES.includes(order.status as 'expired' | 'cancelled')) {
      throw new BadRequestException('cash_order_not_restorable');
    }
    const event = await this.loadEvent(order.event);
    // Скрытое организатором с сайта событие не продаёт: продление — новая бронь мест.
    if (isHiddenFromSite(event)) {
      throw new BadRequestException(EVENT_HIDDEN_ERROR);
    }
    /*
     * Продление снова держит места неоплаченными ещё час — это та же бронь за
     * наличные, поэтому в последний час до начала она закрыта. «Перевыпуск»
     * оплачивает заказ сразу и под это ограничение не попадает.
     */
    if (isCashBookingClosed(event, order.tickets ?? [])) {
      throw new BadRequestException('cash_booking_closed');
    }
    await this.activateExpiredOrderReservation(order, event);
    await order.save();
    return this.getCashOrderDetails(order.id);
  }

  async reissueExpiredCashOrder(orderId: number, actor: CashOrdersActor) {
    const order = await this.mockOrderModel.findOne({ id: orderId, paymentMethod: 'CASH' }).exec();
    if (!order) {
      throw new NotFoundException('cash_order_not_found');
    }
    if (!RESTORABLE_CASH_STATUSES.includes(order.status as 'expired' | 'cancelled')) {
      throw new BadRequestException('cash_order_not_restorable');
    }
    const event = await this.loadEvent(order.event);
    // Перевыпуск — это новая продажа тех же мест: для скрытого с сайта события запрещён.
    if (isHiddenFromSite(event)) {
      throw new BadRequestException(EVENT_HIDDEN_ERROR);
    }
    await this.activateExpiredOrderReservation(order, event);
    const posLocation =
      actor.type === 'CashierArbi' ? actor.pos_location : order.selectedPos ?? 'Admin';
    const cashierEmail = actor.type === 'CashierArbi' ? actor.email : 'admin';
    await this.finalizeCashOrderAsPaid(order, actor, posLocation, cashierEmail);
    return this.getCashOrderDetails(order.id);
  }

  @Cron('*/5 * * * *')
  async expirePendingCashOrders(): Promise<void> {
    const threshold = new Date(Date.now() - CASH_BOOKING_TTL_MS);
    const orders = await this.mockOrderModel
      .find({
        paymentMethod: 'CASH',
        status: 'pending_cash',
        $or: [
          { cashBookingExpiresAt: { $lte: new Date() } },
          { cashBookingExpiresAt: { $exists: false }, createdAt: { $lt: threshold } },
        ],
      })
      .exec();
    for (const order of orders) {
      order.status = 'expired';
      await order.save();
      try {
        const [customer, event] = await Promise.all([
          this.loadCustomer(order.customer),
          this.loadEvent(order.event),
        ]);
        await this.sendCashCancelledEmail(order, customer, event, 'expired');
      } catch (error) {
        this.logger.warn(
          `Cash booking expiration email failed for order ${order.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  private escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private get cmsPageModel(): mongoose.Model<ICmsPage> {
    return (
      (mongoose.models.ContentCmsPage as mongoose.Model<ICmsPage>) ??
      mongoose.model<ICmsPage>('ContentCmsPage', CmsPageSchema)
    );
  }

  /**
   * Все написания одной точки. selectedPos хранит локализованный заголовок
   * карточки на языке клиента, а posLocation кассира — на языке админа, так
   * что сравнивать одну строку нельзя: собираем все заголовки карточки CMS.
   */
  private async resolvePosAliases(posLocation: string): Promise<string[]> {
    const normalize = (value?: string) => value?.trim().toLocaleLowerCase() ?? '';
    const identifier = normalize(posLocation);
    const aliases = new Set<string>([posLocation.trim()]);
    if (!identifier) return Array.from(aliases);

    const pages = await this.cmsPageModel
      .find({ publication: 'published' })
      .select({ sections: 1 })
      .lean()
      .exec();

    const itemCandidates = (item: CmsRepeaterItem): string[] => {
      const titleField = item.fields.find((field) => field.id === 'title');
      const localizedTitles =
        titleField &&
        (titleField.type === 'text' ||
          titleField.type === 'textarea' ||
          titleField.type === 'richText')
          ? Object.values(titleField.value)
          : [];
      return [item.id, item.unique_id, item.title, ...localizedTitles].filter(
        (candidate): candidate is string =>
          typeof candidate === 'string' && candidate.trim().length > 0,
      );
    };

    for (const page of pages) {
      for (const section of page.sections ?? []) {
        if (!section.visible) continue;
        for (const field of section.fields ?? []) {
          if (field.type !== 'repeater' || !isLocationRepeaterId(field.id)) continue;
          for (const item of field.items) {
            if (item.showCard === false) continue;
            const candidates = itemCandidates(item);
            if (candidates.some((candidate) => normalize(candidate) === identifier)) {
              for (const candidate of candidates) aliases.add(candidate.trim());
              return Array.from(aliases);
            }
          }
        }
      }
    }
    return Array.from(aliases);
  }

  private async buildCashOrdersFilter(
    query: CashOrdersQueryDto,
    actor?: CashOrdersActor,
  ): Promise<Record<string, unknown> | null> {
    const filter: Record<string, unknown> = {
      paymentMethod: 'CASH',
      status: query.status ?? { $in: ['pending_cash', 'paid', 'expired', 'cancelled'] },
    };
    /*
     * Кассир по умолчанию (scope отсутствует или 'own') видит в списке только
     * заказы своей точки; pos из query для него игнорируется. Отдельным
     * переключателем (scope='all') он смотрит брони всех точек — тогда фильтр
     * pos работает так же, как у админа. Для админа scope игнорируется.
     * Подтверждению чужого заказа по коду это не мешает — lookup, детали и
     * действия (confirm/extend/reissue/cancel) точкой не ограничены.
     */
    const cashierScoped = actor?.type === 'CashierArbi' && query.scope !== 'all';
    if (cashierScoped && actor?.type === 'CashierArbi') {
      const aliases = await this.resolvePosAliases(actor.pos_location);
      filter.selectedPos = {
        $in: aliases.map(
          (alias) => new RegExp(`^\\s*${this.escapeRegex(alias)}\\s*$`, 'i'),
        ),
      };
    }
    const orderIdTerm = query.orderId?.trim();
    if (orderIdTerm) {
      filter.$expr = {
        $regexMatch: {
          input: { $toString: '$id' },
          regex: new RegExp(this.escapeRegex(orderIdTerm), 'i'),
        },
      };
    }
    if (!cashierScoped && query.pos?.trim()) {
      const posRegex = new RegExp(this.escapeRegex(query.pos.trim()), 'i');
      filter.$or = [{ selectedPos: posRegex }, { actualPos: posRegex }];
    }
    const emailTerm = query.email?.trim();
    const customerNameTerm = query.customerName?.trim();
    if (emailTerm || customerNameTerm) {
      const customerFilter: Record<string, unknown> = {};
      if (emailTerm) {
        customerFilter.email = new RegExp(this.escapeRegex(emailTerm), 'i');
      }
      if (customerNameTerm) {
        customerFilter.fullname = new RegExp(this.escapeRegex(customerNameTerm), 'i');
      }
      const customers = await this.customerModel.find(customerFilter).select('id').lean().exec();
      const customerIds = customers.map((customer) => customer.id);
      if (!customerIds.length) {
        return null;
      }
      filter.customer = { $in: customerIds };
    }
    return filter;
  }

  private async mapCashOrderRows(orders: IMockOrder[]) {
    const customerIds = Array.from(new Set(orders.map((order) => order.customer)));
    const eventIds = Array.from(new Set(orders.map((order) => order.event)));
    const [customers, events] = await Promise.all([
      this.customerModel.find({ id: { $in: customerIds } }).select('id fullname email').lean().exec(),
      this.eventModel.find({ id: { $in: eventIds } }).select('id title eventDate time').lean().exec(),
    ]);
    const customerById = new Map<number, Pick<ICustomer, 'id' | 'fullname' | 'email'>>(
      (customers as Array<Pick<ICustomer, 'id' | 'fullname' | 'email'>>).map((customer) => [
        customer.id,
        customer,
      ]),
    );
    const eventById = new Map<number, Pick<IEvent, 'id' | 'title' | 'eventDate' | 'time'>>(
      (events as Array<Pick<IEvent, 'id' | 'title' | 'eventDate' | 'time'>>).map((event) => [
        event.id,
        event,
      ]),
    );
    return orders.map((order) => {
      const customer = customerById.get(order.customer);
      const event = eventById.get(order.event);
      return {
        id: order.id,
        bookingCode: order.bookingCode ?? null,
        createdAt: new Date(order.createdAt).toISOString(),
        event: order.event,
        eventTitle: this.pickLocalizedText(
          event?.title,
          this.resolveLocale(order.locale),
          `Event #${order.event}`,
        ),
        eventDate: event?.eventDate ?? null,
        time: event?.time ?? null,
        /**
         * Distinct shows this booking covers. Empty for one-off events; for a regular
         * event the cashier needs the dates on the list, not just the event title.
         */
        sessions: this.summariseOrderSessions(order),
        customerName: customer?.fullname ?? '',
        email: customer?.email ?? '',
        total_price: order.total_price,
        selected_pos: order.selectedPos ?? null,
        actual_pos: order.actualPos ?? null,
        cashier_email: order.cashierEmail ?? null,
        payment_confirmed_at: order.paymentConfirmedAt
          ? new Date(order.paymentConfirmedAt).toISOString()
          : null,
        expires_at: order.cashBookingExpiresAt ? new Date(order.cashBookingExpiresAt).toISOString() : null,
        cancelled_by: order.cancelledBy ?? null,
        cancelled_at: order.cancelledAt ? new Date(order.cancelledAt).toISOString() : null,
        cancelled_pos: order.cancelledPos ?? null,
        status: order.status,
        paymentMethod: 'CASH',
      };
    });
  }

  /** Distinct `date/start/end` triples across an order's lines, chronological. */
  private summariseOrderSessions(
    order: Pick<IMockOrder, 'tickets'>,
  ): Array<{ date: string; start: string; end: string; count: number }> {
    const byKey = new Map<string, { date: string; start: string; end: string; count: number }>();
    for (const line of order.tickets ?? []) {
      if (!line.sessionDate) continue;
      const start = line.sessionStart ?? '';
      const end = line.sessionEnd ?? '';
      const key = `${line.sessionDate}T${start}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.count += line.count ?? 0;
      } else {
        byKey.set(key, { date: line.sessionDate, start, end, count: line.count ?? 0 });
      }
    }
    return [...byKey.values()].sort((a, b) =>
      `${a.date}T${a.start}`.localeCompare(`${b.date}T${b.start}`),
    );
  }

  private async mapCashOrderDetails(order: IMockOrder, customer: ICustomer, event: IEvent) {
    const ticketCount = (order.tickets ?? []).reduce((sum, ticket) => sum + (ticket.count ?? 0), 0);
    const tickets = (order.tickets ?? []).map((ticket) => {
      const sector = event.sectors?.find((candidate) => candidate.id === ticket.sectorId);
      const zone = sector?.zones?.find((candidate) => candidate.id === ticket.zoneId);
      return {
        sectorId: ticket.sectorId,
        zoneId: ticket.zoneId,
        price: ticket.price,
        currency: ticket.currency,
        count: ticket.count,
        // Regular events: the cashier must see which show each line is for.
        session: ticket.session ?? null,
        sessionDate: ticket.sessionDate ?? null,
        sessionStart: ticket.sessionStart ?? null,
        sessionEnd: ticket.sessionEnd ?? null,
        sector: {
          id: ticket.sectorId,
          name: sector?.name ?? { th: '', en: '', ru: '' },
          color: sector?.color ?? null,
        },
        zone: {
          id: ticket.zoneId,
          name: zone?.name ?? { th: '', en: '', ru: '' },
          seats: zone?.seats ?? null,
          isFree: zone?.isFree ?? null,
          price: zone?.price ?? ticket.price,
          currency: zone?.currency ?? ticket.currency,
        },
      };
    });
    return {
      id: order.id,
      createdAt: new Date(order.createdAt).toISOString(),
      event: order.event,
      eventTitle: event.title,
      eventDate: event.eventDate,
      time: event.time,
      sessions: this.summariseOrderSessions(order),
      buyer: {
        id: customer.id,
        fullname: customer.fullname,
        email: customer.email,
        phone: customer.phone ?? '',
      },
      tickets,
      ticketCount,
      price: order.price,
      total_price: order.total_price,
      vat: order.vat,
      additionalTicketCostFee: order.additionalTicketCostFee,
      promocodeDiscount: order.promocodeDiscount ?? null,
      paymentMethod: 'CASH',
      paymentCurrency: order.paymentCurrency,
      selected_pos: order.selectedPos ?? null,
      actual_pos: order.actualPos ?? null,
      cashier_email: order.cashierEmail ?? null,
      payment_confirmed_at: order.paymentConfirmedAt
        ? new Date(order.paymentConfirmedAt).toISOString()
        : null,
      expires_at: order.cashBookingExpiresAt ? new Date(order.cashBookingExpiresAt).toISOString() : null,
      bookingCode: order.bookingCode ?? null,
      cancelled_by: order.cancelledBy ?? null,
      cancelled_at: order.cancelledAt ? new Date(order.cancelledAt).toISOString() : null,
      cancelled_pos: order.cancelledPos ?? null,
      status: order.status,
    };
  }

  private async sendCashBookingEmail(order: IMockOrder, customer: ICustomer, event: IEvent): Promise<void> {
    const locale = this.resolveLocale(order.locale);
    const dict = CASH_BOOKING_EMAIL_LOCALES[locale].booking;
    const bookingNumber = this.bookingNumberOf(order);
    const eventTitle = this.pickLocalizedText(event.title, locale, `Event #${event.id}`);
    const expiresAt = order.cashBookingExpiresAt
      ? this.formatExpiresAt(new Date(order.cashBookingExpiresAt), locale)
      : '';
    const ticketCount = (order.tickets ?? []).reduce((sum, ticket) => sum + (ticket.count ?? 0), 0);
    const buyerName = customer.fullname?.trim() || customer.email;
    const publicBaseUrl = this.getTicketPublicBaseUrl();
    const logoUrl = publicBaseUrl ? `${publicBaseUrl}/logo.png` : '';
    const venue = venueOneLine(event.venue) || '—';
    const bodyRowsHtml = [
      emailDetailRow(dict.fields.bookingNumber, bookingNumber, true),
      emailDetailRow(dict.fields.event, eventTitle, true),
      emailDetailRow(dict.fields.buyer, `${buyerName} (${customer.email})`),
      emailDetailRow(dict.fields.tickets, String(ticketCount)),
      emailDetailRow(dict.fields.amount, `${order.total_price} THB`),
      emailDetailRow(dict.fields.selectedPos, order.selectedPos ?? '—'),
      emailDetailRow(dict.fields.venue, venue),
      emailDetailRow(dict.fields.validUntil, expiresAt || '—'),
    ].join('');
    const text = [
      dict.title,
      `${dict.fields.bookingNumber}: ${bookingNumber}`,
      `${dict.fields.event}: ${eventTitle}`,
      `${dict.fields.tickets}: ${ticketCount}`,
      `${dict.fields.amount}: ${order.total_price} THB`,
      `${dict.fields.selectedPos}: ${order.selectedPos ?? ''}`,
      `${dict.fields.venue}: ${venue}`,
      `${dict.fields.validUntil}: ${expiresAt}`,
      dict.subtitle,
    ].join('\n');
    await this.notificationService.sendEmail({
      to: customer.email,
      subject: `${dict.subject} #${bookingNumber}`,
      text,
      html: buildBrandedEmailHtml({
        logoUrl,
        title: dict.title,
        subtitle: dict.subtitle,
        bodyRowsHtml,
        footer: dict.footer,
      }),
    });
  }

  private async sendCashCancelledEmail(
    order: IMockOrder,
    customer: ICustomer,
    event: IEvent,
    kind: 'cancelled' | 'expired' = 'cancelled',
  ): Promise<void> {
    const locale = this.resolveLocale(order.locale);
    const dict = CASH_BOOKING_EMAIL_LOCALES[locale][kind];
    const bookingNumber = this.bookingNumberOf(order);
    const eventTitle = this.pickLocalizedText(event.title, locale, `Event #${event.id}`);
    const expiresAt = order.cashBookingExpiresAt
      ? this.formatExpiresAt(new Date(order.cashBookingExpiresAt), locale)
      : '—';
    const ticketCount = (order.tickets ?? []).reduce((sum, ticket) => sum + (ticket.count ?? 0), 0);
    const buyerName = customer.fullname?.trim() || customer.email;
    const venue = venueOneLine(event.venue) || '—';
    const publicBaseUrl = this.getTicketPublicBaseUrl();
    const logoUrl = publicBaseUrl ? `${publicBaseUrl}/logo.png` : '';
    const bodyRowsHtml = [
      emailDetailRow(dict.fields.bookingNumber, bookingNumber, true),
      emailDetailRow(dict.fields.event, eventTitle, true),
      emailDetailRow(dict.fields.buyer, `${buyerName} (${customer.email})`),
      emailDetailRow(dict.fields.tickets, String(ticketCount)),
      emailDetailRow(dict.fields.amount, `${order.total_price} THB`),
      emailDetailRow(dict.fields.selectedPos, order.selectedPos ?? '—'),
      emailDetailRow(dict.fields.venue, venue),
      emailDetailRow(dict.fields.validUntil, expiresAt),
    ].join('');
    await this.notificationService.sendEmail({
      to: customer.email,
      subject: `${dict.subject} #${bookingNumber}`,
      text: [
        dict.title,
        `${dict.fields.bookingNumber}: ${bookingNumber}`,
        `${dict.fields.event}: ${eventTitle}`,
        `${dict.fields.buyer}: ${buyerName} (${customer.email})`,
        `${dict.fields.tickets}: ${ticketCount}`,
        `${dict.fields.amount}: ${order.total_price} THB`,
        `${dict.fields.selectedPos}: ${order.selectedPos ?? ''}`,
        `${dict.fields.venue}: ${venue}`,
        `${dict.fields.validUntil}: ${expiresAt}`,
        dict.subtitle,
      ].join('\n'),
      html: buildBrandedEmailHtml({
        logoUrl,
        title: dict.title,
        subtitle: dict.subtitle,
        bodyRowsHtml,
        footer: dict.footer,
      }),
    });
  }
}
