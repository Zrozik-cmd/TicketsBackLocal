import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
  OnModuleInit,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import mongoose from 'mongoose';
import { MockOrderSchema, IMockOrder, IMockOrderTicket } from './schemas/mock-order.schema';
import { CustomerSchema, ICustomer } from '../customers/schemas/customer.schema';
import { CreateMockOrderDto } from './dto/create-mock-order.dto';
import { CreateFreePromoMockOrderDto } from './dto/create-free-promo-mock-order.dto';
import type { PromoCodeTicketCheckResponseDto } from '../promocodes/dto/promo-code-ticket-check-response.dto';
import {
  getArbiPaymentMethod,
  toMinorUnits,
} from './constants/payment-currency.constant';
import { EventsService } from '../events/events.service';
import { isSalesClosed } from '../events/constants/event-status.constant';
import {
  EVENT_HIDDEN_ERROR,
  isHiddenFromSite,
} from '../events/constants/event-visibility.constant';
import { isEventSalesEnded } from '../events/utils/sales-cutoff.util';
import {
  EventSessionsService,
  type SessionWithAvailability,
} from '../event-sessions/event-sessions.service';
import { SessionCancellationNotifier } from '../event-sessions/session-cancellation-notifier.service';
import { IZone, type EventTicketFormat, type IEvent } from '../events/schemas/event.schema';
import {
  eventFeeRatesFromPercents,
  resolveEventFeePercents,
} from '../events/utils/event-fee.util';
import { TicketsService } from '../tickets/tickets.service';
import { TicketPuppeteerService } from '../../services/puppeteer/ticket-puppeteer.service';
import { PaymentMicroserviceService } from './payment/payment-microservice.service';
import { OmisePaymentService } from './payment/omise-payment.service';
import { ArbiPayStoresService } from '../arbipay-stores/arbipay-stores.service';
import type { CreateMockOrderResponseDto } from './dto/create-mock-order-response.dto';
import type { OmiseEventPayload } from './payment/omise-payment.types';
import {
  buildArbipayThbTransaction,
  checkArbipayThbCheckout,
  resolveArbipayProviderFeePercents,
} from './utils/arbipay-thb-payment.util';
import { resolveOriginalPaidAmount } from './utils/original-paid-amount.util';
import { buildExpiredPendingOrdersFilter } from './utils/pending-order-expiry.util';
import { CustomersService } from '../customers/customers.service';
import { NotificationService } from '../../services/NotificationService/notification.service';
import { TICKET_EMAIL_LOCALES, TicketEmailLocale, attachedTicketLocale } from './locales/ticket-email.locales';
import { ReferralLinksService } from '../referral-links/referral-links.service';
import { PromocodesService } from '../promocodes/promocodes.service';
import { TelegramSalesNotificationService } from '../telegram-notifications/services/telegram-sales-notification.service';
import { EventMessengersNotifierService } from '../event-messengers/services/event-messengers-notifier.service';
// MAILCHIMP-DISABLED: newsletter not ready for prod — uncomment to re-enable
// import { MailchimpService } from '../newsletter/services/mailchimp.service';
import type {
  MockOrderEventSalesStatistics,
  MockOrderSalesStatsBucket,
} from './dto/mock-order-sales-statistics.dto';
import type { EventPricingFeesResponseDto } from './dto/event-pricing-fees-response.dto';
import type {
  MockOrderEventPaidListResponse,
  MockOrderEventPaidListRow,
  MockOrdersPaidListQueryDto,
} from './dto/mock-orders-event-paid-list.dto';
import type { MockOrderRefundDetailsResponse } from './dto/mock-order-refund-details.dto';
import {
  buildRefundCalculation,
  buildRefundSupportMessage,
  refundSnapshotToCalculation,
  resolvePaymentMethodLabel,
  roundMoney,
} from './utils/mock-order-refund.util';
import {
  TICKET_COPY_LOCALE,
  buildTicketCopyEmail,
  buildTicketsEmail,
  TICKET_EMAIL_PDF_MAX_ENCODED_BYTES,
  mimeBase64Size,
  resolveTicketAttachmentFormat,
  ticketAttachmentFile,
} from './utils/ticket-email.util';
import type { ITicket } from '../tickets/schemas/ticket.schema';
import {
  normalizeSessionPeriodFilter,
  periodLinesQuery,
  periodShareExpr,
  type SessionPeriodFilter,
  type SessionPeriodScope,
} from '../events/utils/session-period-filter.util';
import { applyPromoDiscount } from './utils/promo-discount.util';
import { claimOrderSeats, prepareOrderSeats } from '../seat-holds/seat-holds';
import { attachSeatsToLines } from '../seat-holds/utils/seat-holds.util';

const MAX_TICKET_EMAIL_RETRIES = 5;
const TICKET_EMAIL_RETRY_MS = 5 * 60 * 1000;

@Injectable()
export class MockOrdersService implements OnApplicationBootstrap {
  private readonly logger = new Logger(MockOrdersService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly eventsService: EventsService,
    private readonly ticketsService: TicketsService,
    private readonly customersService: CustomersService,
    private readonly notificationService: NotificationService,
    private readonly paymentMicroservice: PaymentMicroserviceService,
    private readonly omisePayment: OmisePaymentService,
    private readonly referralLinksService: ReferralLinksService,
    private readonly promocodesService: PromocodesService,
    private readonly ticketPuppeteerService: TicketPuppeteerService,
    private readonly telegramSalesNotificationService: TelegramSalesNotificationService,
    private readonly eventSessionsService: EventSessionsService,
    // MAILCHIMP-DISABLED: newsletter not ready for prod — uncomment to re-enable
    // private readonly mailchimpService: MailchimpService,
    private readonly sessionCancellationNotifier: SessionCancellationNotifier,
    private readonly messengersNotifier: EventMessengersNotifierService,
    private readonly arbiPayStoresService: ArbiPayStoresService,
  ) { }

  async onApplicationBootstrap(): Promise<void> {
    try {
      await mongoose.connection.asPromise();
  
      const result = await this.mockOrderModel.updateMany(
        {
          status: 'paid',
          ticketEmailStatus: 'pending',
        },
        {
          $set: {
            ticketEmailStatus: 'failed',
            ticketEmailNextRetryAt: new Date(),
            ticketEmailLastError:
              'Email marked as failed after backend restart.',
          },
        },
      );
  
      if ((result.modifiedCount ?? 0) > 0) {
        this.logger.warn(
          `Marked pending ticket emails as failed after restart: ${result.modifiedCount}`,
        );
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Failed to mark pending ticket emails as failed on startup: ${reason}`,
      );
    }
  }

  private get mockOrderModel(): mongoose.Model<IMockOrder> {
    return (mongoose.models.MockOrder as mongoose.Model<IMockOrder>) ??
      mongoose.model<IMockOrder>('MockOrder', MockOrderSchema);
  }

  private get customerModel(): mongoose.Model<ICustomer> {
    return (mongoose.models.Customer as mongoose.Model<ICustomer>) ??
      mongoose.model<ICustomer>('Customer', CustomerSchema);
  }

  private resolveLocale(raw?: string): TicketEmailLocale {
    const value = (raw ?? '').trim().toLowerCase();
    if (value.startsWith('ru')) return 'ru';
    if (value.startsWith('th')) return 'th';
    return 'en';
  }

  private assertOrderPaymentConfirmed(order: IMockOrder): void {
    if (order.status !== 'paid') {
      throw new BadRequestException('payment_not_confirmed');
    }
    if (order.refundStatus === 'refunded' || order.refundStatus === 'refund_in_progress') {
      throw new BadRequestException('ticket_resend_not_allowed_for_refund');
    }
  }

  private pickLocalizedText(
    value: { th?: string; en?: string; ru?: string } | undefined,
    locale: TicketEmailLocale,
    fallback = '',
  ): string {
    if (!value) return fallback;
    const order: TicketEmailLocale[] =
      locale === 'th' ? ['th', 'en', 'ru'] : locale === 'ru' ? ['ru', 'en', 'th'] : ['en', 'th', 'ru'];
    for (const key of order) {
      const text = value[key]?.trim();
      if (text) return text;
    }
    return fallback;
  }

  private resolveOriginalPaidAmountOnConfirm(
    order: IMockOrder,
    paymentInfo?: {
      amount?: number;
      currency?: string;
      payload?: Record<string, unknown>;
    },
  ): number | undefined {
    if (order.paymentCurrency === 'THB') {
      return order.total_price;
    }
    const payloadInputAmount = paymentInfo?.payload?.input_amount;
    if (typeof payloadInputAmount === 'number' && Number.isFinite(payloadInputAmount)) {
      return payloadInputAmount;
    }
    if (
      paymentInfo?.amount != null &&
      paymentInfo.currency === order.paymentCurrency
    ) {
      return paymentInfo.amount / 100;
    }
    return undefined;
  }

  private getTicketPublicBaseUrl(): string {
    const configured = this.config.get<string>('TICKETS_PUBLIC_BASE_URL', '').trim();
    return configured.replace(/\/+$/, '');
  }

  buildTicketWebPWithPuppeteer(
    id: number,
    locale: TicketEmailLocale,
  ): Promise<{ buffer: Buffer; absolutePath: string; filename: string }> {
    return this.ticketPuppeteerService.buildTicketWebPWithPuppeteer(id, locale);
  }

  getTicketByIdAndOpenPreview(
    id: number,
    locale: TicketEmailLocale,
  ): Promise<{ absolutePath: string }> {
    return this.ticketPuppeteerService.getTicketByIdAndOpenPreview(id, locale);
  }

  getTicketWebPBuffer(id: number, locale: TicketEmailLocale): Promise<Buffer> {
    return this.ticketPuppeteerService.getTicketWebPBuffer(id, locale);
  }

  /**
   * An order's tickets as e-mail attachments, one per ticket, in `format`
   * (`resolveTicketAttachmentFormat(event)`): a one-page PDF or a WebP image, named
   * `ticket-{orderId}-{ticketId}.{pdf|webp}`. PDF tickets that would pass
   * `TICKET_EMAIL_PDF_MAX_ENCODED_BYTES` together are replaced by WebP ones for the whole
   * letter. Returns the format actually attached: the letter's subtitle names it. Shared by
   * the buyer's letter, its resends and the organizer copy.
   */
  private async renderTicketAttachments(params: {
    orderId: number;
    tickets: Array<Pick<ITicket, 'id'>>;
    locale: TicketEmailLocale;
    format: EventTicketFormat;
  }): Promise<{
    format: EventTicketFormat;
    attachments: Array<{ filename: string; content: Buffer; contentType: string }>;
  }> {
    if (params.format === 'pdf') {
      const pdfs: Array<{ filename: string; content: Buffer; contentType: string }> = [];
      let encodedBytes = 0;
      for (const ticket of params.tickets) {
        const content = await this.ticketPuppeteerService.getTicketPdfBuffer(ticket.id, params.locale);
        encodedBytes += mimeBase64Size(content.length);
        if (encodedBytes > TICKET_EMAIL_PDF_MAX_ENCODED_BYTES) break;
        pdfs.push({ ...ticketAttachmentFile('pdf', params.orderId, ticket.id), content });
      }
      if (pdfs.length === params.tickets.length) {
        return { format: 'pdf', attachments: pdfs };
      }
      this.logger.warn(
        `Ticket PDFs of order=${params.orderId} exceed the e-mail budget at ticket ${pdfs.length + 1}/${params.tickets.length} ` +
          `(${encodedBytes} > ${TICKET_EMAIL_PDF_MAX_ENCODED_BYTES} encoded bytes): attaching WebP tickets instead`,
      );
    }
    const attachments: Array<{ filename: string; content: Buffer; contentType: string }> = [];
    for (const ticket of params.tickets) {
      const content = await this.getTicketWebPBuffer(ticket.id, params.locale);
      attachments.push({ ...ticketAttachmentFile('webp', params.orderId, ticket.id), content });
    }
    return { format: 'webp', attachments };
  }

  private async generateUniqueMockOrderId(): Promise<number> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = Date.now();
      const exists = await this.mockOrderModel.exists({ id });
      if (!exists) return id;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new BadRequestException('failed_to_generate_order_id');
  }

  /** `wait` → `failed`: ARBI Pay orders (SBP, USDT, KZT, card, PromptPay) after 35 min, THB receipt transfer after 15. */
  @Cron('*/15 * * * *')
  async removeExpiredPendingOrders(): Promise<void> {
    const result = await this.mockOrderModel.updateMany(buildExpiredPendingOrdersFilter(Date.now()), {
      $set: { status: 'failed' },
    });

    if ((result.modifiedCount ?? 0) > 0) {
      this.logger.log(`Marked expired pending orders as failed: ${result.modifiedCount}`);
    }
  }

  private async checkAndApplyPromo(
    dto: CreateMockOrderDto,
    customerId: number,
    options: { requirePromoCode: boolean },
    ticketCount: number,
    priceBeforePromo: number,
  ): Promise<{
    promoCheck: PromoCodeTicketCheckResponseDto | null;
    priceAfterPromo: number;
  }> {
    const trimmedPromo = dto.promoCode?.trim();

    if (options.requirePromoCode && !trimmedPromo) {
      throw new BadRequestException('promo_code_required');
    }

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

    if (options.requirePromoCode && !promoCheck) {
      throw new BadRequestException('promo_code_required');
    }

    const priceAfterPromo = promoCheck
      ? applyPromoDiscount(
          priceBeforePromo,
          promoCheck.discountType,
          promoCheck.discountValue,
        )
      : priceBeforePromo;

    return { promoCheck, priceAfterPromo };
  }

  private async buildOrderPricing(
    dto: CreateMockOrderDto,
    customerId: number,
    options: { requirePromoCode: boolean },
  ): Promise<{
    tickets: IMockOrderTicket[];
    firstCurrency: string;
    priceBeforePromo: number;
    ticketCount: number;
    promoCheck: PromoCodeTicketCheckResponseDto | null;
    priceAfterPromo: number;
    vat: number;
    additionalTicketCostFee: number;
    bankCardFee: number;
    totalPrice: number;
    promoCodeId?: string;
    promoTicketCount?: number;
    promocodeDiscount?: number;
  }> {
    const event = await this.eventsService.findOneByNumericId(dto.event);

    // Hidden from the site by the organizer: a page left open must not sell. Checked
    // before anything is written (card and 100%-promo checkout both price here first).
    if (isHiddenFromSite(event)) {
      throw new BadRequestException(EVENT_HIDDEN_ERROR);
    }

    /*
      Server-side sales barrier (the UI hiding the purchase card is only a
      client-side one): archived, cancelled, paused, rejected or back-in-moderation
      events refuse new orders. One shared predicate so card and cash checkout
      can never disagree on which statuses sell.
    */
    if (isSalesClosed(event)) {
      throw new BadRequestException('Ticket sales for this event are closed.');
    }
    // One-off event past its own "stop sales X hours/days before" cut-off.
    if (isEventSalesEnded(event)) {
      throw new BadRequestException('Ticket sales for this event are closed.');
    }

    /**
     * Regular events sell each session separately, so every order line has to name a
     * session and fit into that session's remaining seats. One-off events keep the
     * previous behaviour and carry no session at all.
     */
    const isRecurringEvent = event.recurrence?.enabled === true;
    const sessionsById = new Map<number, SessionWithAvailability>();
    if (isRecurringEvent) {
      // Only sessions on sale right now: a stale page (or a crafted request) naming
      // yesterday's, a started, a sold-out or a cancelled show must not become an order.
      const sessions = await this.eventSessionsService.getSessionsWithAvailability(dto.event, {
        purchasableOnly: true,
      });
      for (const session of sessions) sessionsById.set(session.id, session);
    }
    /** Seats already taken by earlier lines of *this* order, keyed `session::sector::zone`. */
    const claimedInThisOrder = new Map<string, number>();

    const tickets: IMockOrderTicket[] = [];
    let orderPrice = 0;
    let ticketCount = 0;
    let firstCurrency = 'THB';

    for (const item of dto.tickets) {
      const sector = event.sectors?.find((s) => s.id === item.sectorId);
      if (!sector) {
        throw new BadRequestException(
          `Sector not found: ${item.sectorId} for event ${dto.event}`,
        );
      }
      const zone = sector.zones?.find((z: IZone) => z.id === item.zoneId);
      if (!zone) {
        throw new BadRequestException(
          `Zone not found: ${item.zoneId} in sector ${item.sectorId} for event ${dto.event}`,
        );
      }

      let session: SessionWithAvailability | undefined;
      if (isRecurringEvent) {
        if (typeof item.session !== 'number') {
          throw new BadRequestException(
            `Event ${dto.event} is a regular event: every ticket line must specify a session`,
          );
        }
        session = sessionsById.get(item.session);
        if (!session) {
          throw await this.eventSessionsService.sessionUnavailableError(
            dto.event,
            item.session,
            `Session ${item.session} is not available for event ${dto.event}`,
          );
        }
        const zoneAvailability = session.zones.find(
          (z) => z.sectorId === item.sectorId && z.zoneId === item.zoneId,
        );
        const claimKey = `${session.id}::${item.sectorId}::${item.zoneId}`;
        const alreadyClaimed = claimedInThisOrder.get(claimKey) ?? 0;
        const remaining = (zoneAvailability?.remaining ?? 0) - alreadyClaimed;
        if (item.count > remaining) {
          throw new BadRequestException(
            `Not enough seats left in zone ${item.zoneId} for session ${session.date} ${session.start}: ${remaining} available`,
          );
        }
        claimedInThisOrder.set(claimKey, alreadyClaimed + item.count);
      }

      const price = zone.isFree ? 0 : zone.price;
      const currency = zone.currency ?? 'THB';
      if (tickets.length === 0) firstCurrency = currency;
      const lineTotal = price * item.count;
      orderPrice += lineTotal;
      ticketCount += item.count;
      tickets.push({
        sectorId: item.sectorId,
        zoneId: item.zoneId,
        price,
        currency,
        count: item.count,
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

    const priceBeforePromo = orderPrice;

    const { promoCheck, priceAfterPromo } = await this.checkAndApplyPromo(
      dto,
      customerId,
      options,
      ticketCount,
      priceBeforePromo,
    );

    const promoCodeId = promoCheck?.promoCodeId;
    const promoTicketCount = promoCheck ? ticketCount : undefined;
    const promocodeDiscount = promoCheck
      ? Math.round((priceBeforePromo - priceAfterPromo) * 100) / 100
      : undefined;

    const { vatRate, additionalTicketCostFeeRate } = eventFeeRatesFromPercents(
      resolveEventFeePercents(event),
    );
    const vat = Math.round(priceAfterPromo * vatRate * 100) / 100;
    const additionalTicketCostFee =
      Math.round(priceAfterPromo * additionalTicketCostFeeRate * 100) / 100;
    // No Lotus card surcharge any more (ARBI Pay adds its own fee on its payment page):
    // new orders carry bankCardFee 0; old orders keep theirs for refunds and statistics.
    const totalPrice = roundMoney(priceAfterPromo + vat + additionalTicketCostFee);

    return {
      tickets,
      firstCurrency,
      priceBeforePromo,
      ticketCount,
      promoCheck,
      priceAfterPromo,
      vat,
      additionalTicketCostFee,
      bankCardFee: 0,
      totalPrice,
      ...(promoCodeId && promoTicketCount != null
        ? { promoCodeId, promoTicketCount, promocodeDiscount }
        : {}),
    };
  }

  async create(
    dto: CreateMockOrderDto,
    customerId: number,
  ): Promise<CreateMockOrderResponseDto> {
    const generatedOrderId = await this.generateUniqueMockOrderId();
    const paymentCurrency = dto.paymentCurrency ?? 'RUB';
    const p = await this.buildOrderPricing(dto, customerId, {
      requirePromoCode: false,
    });
    const arbiFees = resolveArbipayProviderFeePercents((key) => this.config.get<string>(key));
    const arbiThb = checkArbipayThbCheckout(paymentCurrency, dto.omisePaymentMethod, p.totalPrice, arbiFees);
    if (arbiThb.error) throw new BadRequestException(arbiThb.error); // ARBI Pay limits: before any write
    const seats = await prepareOrderSeats(dto.event, dto.tickets); // seating plan seats: free, before any write

    const payload = {
      id: generatedOrderId,
      event: dto.event,
      customer: customerId,
      paymentCurrency,
      locale: this.resolveLocale(dto.locale),
      price: p.priceAfterPromo,
      total_price: p.totalPrice,
      vat: p.vat,
      additionalTicketCostFee: p.additionalTicketCostFee,
      bankCardFee: p.bankCardFee,
      ...(arbiThb.plan ? { paymentMethod: arbiThb.plan.orderPaymentMethod } : {}),
      status: 'wait' as const,
      tickets: attachSeatsToLines(p.tickets, seats),
      ...(dto.newsletterOptIn ? { newsletterOptIn: true } : {}),
      ...(p.promoCodeId && p.promoTicketCount != null
        ? {
            promoCodeId: p.promoCodeId,
            promoTicketCount: p.promoTicketCount,
            promocodeDiscount: p.promocodeDiscount,
          }
        : {}),
    };
    const order = new this.mockOrderModel(payload);
    const saved: IMockOrder = await order.save();
    await claimOrderSeats(saved.id, seats, () => this.markPaymentFailed(saved.id)); // before the payment page
    this.logger.log(`MockOrder created: id=${saved.id}`);

    const paymentMethod = getArbiPaymentMethod(paymentCurrency);
    const paymentDescription =
      paymentCurrency === 'KZT'
        ? `Оплата заказа (KZT) #${saved.id}`
        : `Оплата заказа #${saved.id}`;

    let payment: CreateMockOrderResponseDto['payment'] | null = null;
    // Every ARBI Pay payment (card / PromptPay and SBP / USDT / KZT) goes to the event's own store.
    const viaArbiPay = Boolean(arbiThb.plan) || (paymentCurrency !== 'THB' && this.paymentMicroservice.isEnabled());
    const storeCode = viaArbiPay ? await this.arbiPayStoresService.storeCodeForPayment(saved.event, saved.id) : null;
    if (arbiThb.plan) {
      // Buyer pays on ARBI Pay's page (card form / PromptPay QR); its webhook confirms the order.
      payment = await this.paymentMicroservice
        .createTransaction(buildArbipayThbTransaction(saved.id, arbiThb.plan, p.totalPrice, storeCode))
        .catch(async (e: unknown) => {
          // No payment page reached the buyer: give the seats back now, not after 35 min.
          await this.markPaymentFailed(saved.id).catch(() => undefined);
          throw e;
        });
    } else if (paymentCurrency === 'THB') {
      // Legacy THB manual check/static QR flow (receipt upload confirms payment).
      payment = null;
    } else if (this.paymentMicroservice.isEnabled()) {
      payment = await this.paymentMicroservice.createTransaction({
        orderId: saved.id,
        amountInMinorUnits: toMinorUnits(p.totalPrice),
        currency: paymentCurrency,
        outputCurrency: p.firstCurrency,
        description: paymentDescription,
        paymentMethod,
        storeCode,
      });
    }

    const originalPaidAmount = resolveOriginalPaidAmount(
      paymentCurrency,
      p.totalPrice,
      payment,
    );
    if (originalPaidAmount != null) {
      saved.originalPaidAmount = originalPaidAmount;
      await saved.save();
    }

    return {
      order: {
        id: saved.id,
        event: saved.event,
        customer: saved.customer,
        paymentCurrency: saved.paymentCurrency,
        price: saved.price,
        total_price: saved.total_price,
        vat: saved.vat,
        additionalTicketCostFee: saved.additionalTicketCostFee,
        bankCardFee: saved.bankCardFee ?? 0,
        ...(saved.originalPaidAmount != null
          ? { originalPaidAmount: saved.originalPaidAmount }
          : {}),
        status: saved.status,
        tickets: saved.tickets,
        ...(saved.promocodeDiscount != null
          ? { promocodeDiscount: saved.promocodeDiscount }
          : {}),
        createdAt: saved.createdAt.toISOString(),
        updatedAt: saved.updatedAt.toISOString(),
      },
      payment,
    };
  }

  /**
   * Checkout with a 100% percentage promo only: creates a mock order, skips the payment microservice,
   * and confirms immediately (tickets + email + promo usage), same as a successful webhook.
   */
  async createFreeWithFullPromoOrder(
    dto: CreateFreePromoMockOrderDto,
    customerId: number,
  ): Promise<CreateMockOrderResponseDto> {
    const asCreateDto: CreateMockOrderDto = {
      event: dto.event,
      customer: customerId,
      locale: dto.locale,
      promoCode: dto.promoCode,
      tickets: dto.tickets,
      newsletterOptIn: dto.newsletterOptIn,
    };

    const p = await this.buildOrderPricing(asCreateDto, customerId, {
      requirePromoCode: true,
    });

    if (!p.promoCheck) {
      throw new BadRequestException('promo_code_required');
    }
    if (
      p.promoCheck.discountType !== 'percentage' ||
      p.promoCheck.discountValue !== 100
    ) {
      throw new BadRequestException('full_percentage_promo_required');
    }
    if (p.priceAfterPromo !== 0 || p.totalPrice !== 0) {
      throw new BadRequestException('order_not_fully_discounted');
    }
    const seats = await prepareOrderSeats(dto.event, dto.tickets);

    const generatedOrderId = await this.generateUniqueMockOrderId();
    const payload = {
      id: generatedOrderId,
      event: dto.event,
      customer: customerId,
      paymentCurrency: 'RUB' as const,
      locale: this.resolveLocale(dto.locale),
      price: p.priceAfterPromo,
      total_price: p.totalPrice,
      vat: p.vat,
      additionalTicketCostFee: p.additionalTicketCostFee,
      bankCardFee: p.bankCardFee,
      status: 'wait' as const,
      tickets: attachSeatsToLines(p.tickets, seats),
      originalPaidAmount: 0,
      ...(dto.newsletterOptIn ? { newsletterOptIn: true } : {}),
      ...(p.promoCodeId && p.promoTicketCount != null
        ? {
            promoCodeId: p.promoCodeId,
            promoTicketCount: p.promoTicketCount,
            promocodeDiscount: p.promocodeDiscount,
          }
        : {}),
    };

    const order = new this.mockOrderModel(payload);
    const saved = await order.save();
    await claimOrderSeats(saved.id, seats, () => this.markPaymentFailed(saved.id));
    this.logger.log(
      `MockOrder free-promo (100%) created: id=${saved.id}, confirming without payment`,
    );

    const paid = await this.confirmPayment(saved.id);

    return {
      order: {
        id: paid.id,
        event: paid.event,
        customer: paid.customer,
        paymentCurrency: paid.paymentCurrency,
        price: paid.price,
        total_price: paid.total_price,
        vat: paid.vat,
        additionalTicketCostFee: paid.additionalTicketCostFee,
        originalPaidAmount: paid.originalPaidAmount ?? 0,
        status: paid.status,
        tickets: paid.tickets,
        ...(paid.promocodeDiscount != null
          ? { promocodeDiscount: paid.promocodeDiscount }
          : {}),
        createdAt: paid.createdAt.toISOString(),
        updatedAt: paid.updatedAt.toISOString(),
      },
      payment: null,
    };
  }

  private async sendTicketsEmailForOrder(params: {
    orderId: number;
    force: boolean;
    localeOverride?: TicketEmailLocale;
  }): Promise<void> {
    const order = await this.mockOrderModel.findOne({ id: params.orderId }).exec();
    if (!order || order.status !== 'paid') return;
    if (!params.force && order.ticketEmailStatus === 'sent') return;

    const locale = params.localeOverride ?? this.resolveLocale(order.locale);
    const dict = TICKET_EMAIL_LOCALES[locale];
    const attempt = (order.ticketEmailAttempts ?? 0) + 1;

    order.ticketEmailAttempts = attempt;
    order.ticketEmailStatus = 'pending';
    order.ticketEmailLastError = '';
    await order.save();

    try {
      const [customer, event, tickets] = await Promise.all([
        this.customersService.findById(String(order.customer)),
        this.eventsService.findOneByNumericId(order.event),
        this.ticketsService.findByOrderForCustomer(order.id, order.customer),
      ]);

      if (!customer?.email) {
        throw new Error(`Customer email not found for customer=${order.customer}`);
      }
      if (!tickets.length) {
        throw new Error(`No tickets found for paid order=${order.id}`);
      }

      const eventTitle = this.pickLocalizedText(event.title, locale, `Event #${event.id}`);
      const publicBaseUrl = this.getTicketPublicBaseUrl();
      const ticketFormat = resolveTicketAttachmentFormat(event);
      const ticketAttachmentsTimer = `mockOrders:ticketAttachments:order-${order.id}`;
      console.log(
        `[mockOrders] Generating ${tickets.length} ticket ${ticketFormat === 'pdf' ? 'PDF' : 'WebP'} attachment(s) for order ${order.id}`,
      );
      console.time(ticketAttachmentsTimer);
      const { format: attachedFormat, attachments } = await this.renderTicketAttachments({
        orderId: order.id,
        tickets,
        locale: attachedTicketLocale(locale),
        format: ticketFormat,
      });
      console.timeEnd(ticketAttachmentsTimer);

      await this.notificationService.sendEmail({
        to: customer.email,
        ...buildTicketsEmail({
          dict,
          eventTitle,
          buyerName: customer.fullname,
          buyerEmail: customer.email,
          logoUrl: publicBaseUrl ? `${publicBaseUrl}/logo.png` : '',
          ticketFormat: attachedFormat,
        }),
        attachments,
      });

      order.ticketEmailStatus = 'sent';
      order.ticketEmailLastError = '';
      order.ticketEmailLastSentAt = new Date();
      order.ticketEmailNextRetryAt = undefined;
      order.locale = locale;
      await order.save();
      this.logger.log(`Tickets email sent for order=${order.id}`);

      // Detached: the buyer's letter (and a cashier waiting on it) never waits for or
      // fails with the organizer copy.
      const copyTo = event.ticketCopyEmail?.trim();
      if (copyTo) {
        void this.sendTicketCopyEmail({ orderId: order.id, copyTo, event, customer, tickets }).catch(
          (error) => {
            this.logger.error(
              `Ticket copy email failed for order=${order.id}: ${error instanceof Error ? error.message : String(error)}`,
            );
          },
        );
      }
    } catch (error) {
      order.ticketEmailStatus = 'failed';
      order.ticketEmailLastError = error instanceof Error ? error.message : String(error);
      order.ticketEmailNextRetryAt =
        attempt < MAX_TICKET_EMAIL_RETRIES ? new Date(Date.now() + TICKET_EMAIL_RETRY_MS) : undefined;
      await order.save();
      this.logger.error(`Tickets email send failed for order=${order.id}: ${order.ticketEmailLastError}`);
      throw error;
    }
  }

  /**
   * English copy of an order's tickets for the event's `ticketCopyEmail` (the
   * organizer's box). At most once per order: the attachments are rendered first, then
   * `ticketCopyEmailSentAt` is claimed with a conditional update, so retries, resends
   * and two concurrent sends never mail a second copy. The buyer's `ticketEmailStatus`
   * is never touched. A failed attempt — the render, or the SMTP server refusing the
   * letter (the claim is then released) — is counted on the order and retried by
   * `retryFailedTicketCopyEmails` while attempts remain, as well as by the next send of
   * the buyer's e-mail.
   */
  private async sendTicketCopyEmail(params: {
    orderId: number;
    copyTo: string;
    event: IEvent;
    customer: Pick<ICustomer, 'id' | 'fullname' | 'email' | 'phone'>;
    tickets: Array<Pick<ITicket, 'id'>>;
  }): Promise<void> {
    const { orderId, copyTo, event, customer, tickets } = params;
    const alreadySent = await this.mockOrderModel
      .exists({ id: orderId, ticketCopyEmailSentAt: { $exists: true } })
      .exec();
    if (alreadySent) return;

    try {
      // Rendered again for the copy: the buyer's attachments may carry another locale.
      const { format: ticketFormat, attachments } = await this.renderTicketAttachments({
        orderId,
        tickets,
        locale: TICKET_COPY_LOCALE,
        format: resolveTicketAttachmentFormat(event),
      });

      const claim = await this.mockOrderModel
        .updateOne(
          { id: orderId, ticketCopyEmailSentAt: { $exists: false } },
          { $set: { ticketCopyEmailSentAt: new Date() } },
        )
        .exec();
      if (!claim.modifiedCount) return; // a concurrent send got there first

      const publicBaseUrl = this.getTicketPublicBaseUrl();
      const letter = buildTicketCopyEmail({
        orderId,
        event,
        buyer: customer,
        logoUrl: publicBaseUrl ? `${publicBaseUrl}/logo.png` : '',
        ticketFormat,
      });
      try {
        // The throwing variant: `sendEmail` swallows SMTP errors, which would keep the claim.
        await this.notificationService.sendEmailOrThrow({ to: copyTo, ...letter, attachments });
      } catch (error) {
        await this.mockOrderModel
          .updateOne({ id: orderId }, { $unset: { ticketCopyEmailSentAt: 1 } })
          .exec();
        throw error;
      }
    } catch (error) {
      await this.recordTicketCopyEmailFailure(orderId, error);
      throw error;
    }

    await this.mockOrderModel
      .updateOne(
        { id: orderId, ticketCopyEmailAttempts: { $exists: true } },
        {
          $unset: {
            ticketCopyEmailAttempts: 1,
            ticketCopyEmailLastError: 1,
            ticketCopyEmailNextRetryAt: 1,
          },
        },
      )
      .exec()
      .catch(() => undefined);
    this.logger.log(`Ticket copy email sent for order=${orderId} to ${copyTo}`);
  }

  async findById(id: number): Promise<IMockOrder> {
    const order = await this.mockOrderModel.findOne({ id }).lean().exec();
    if (!order) {
      throw new NotFoundException(`MockOrder with id ${id} not found`);
    }
    return order as IMockOrder;
  }

  async findOrderIdsByCustomerId(customerId: number): Promise<number[]> {
    const rows = await this.mockOrderModel
      .find({ customer: customerId, status: 'paid' })
      .select('id')
      .sort({ id: -1 })
      .lean()
      .exec();
    return rows.map((r) => r.id);
  }

  /**
   * VAT and additional ticket cost fee percents (and decimal rates) for an event,
   * aligned with {@link buildOrderPricing} (base = promo-adjusted subtotal).
   */
  async getEventPricingFeesForCheckout(
    eventId: number,
  ): Promise<EventPricingFeesResponseDto> {
    const event = await this.eventsService.findOneByNumericId(eventId);
    const percents = resolveEventFeePercents(event);
    const rates = eventFeeRatesFromPercents(percents);
    return {
      eventId,
      vatPercent: percents.vatPercent,
      additionalTicketCostFeePercent: percents.additionalTicketCostFeePercent,
      bankCardFeePercent: 0, // no Lotus card surcharge any more; kept for older checkout builds
      cashFeePercent: percents.cashFeePercent,
      vatRate: rates.vatRate,
      additionalTicketCostFeeRate: rates.additionalTicketCostFeeRate,
      bankCardFeeRate: 0,
      cashFeeRate: rates.cashFeeRate,
      providerFeePercents: resolveArbipayProviderFeePercents((key) => this.config.get<string>(key)),
    };
  }

  /**
   * Confirms payment for an order (webhook from payment system).
   * Changes status from wait to paid.
   */
  async confirmPayment(
    orderId: number,
    paymentInfo?: {
      amount?: number;
      currency?: string;
      payload?: Record<string, unknown>;
    },
  ): Promise<IMockOrder> {
    const order = await this.mockOrderModel.findOne({ id: orderId }).exec();
    if (!order) {
      throw new NotFoundException(`MockOrder with id ${orderId} not found`);
    }
    if (order.status !== 'wait') {
      throw new BadRequestException(
        `Order ${orderId} cannot be confirmed: current status is ${order.status}`,
      );
    }
    if (order.originalPaidAmount == null) {
      const originalPaidAmount = this.resolveOriginalPaidAmountOnConfirm(order, paymentInfo);
      if (originalPaidAmount != null) {
        order.originalPaidAmount = originalPaidAmount;
      }
    }
    await this.ticketsService.createFromOrder(order);
    order.status = 'paid';
    order.ticketEmailStatus = 'pending';
    order.ticketEmailAttempts = 0;
    order.ticketEmailLastError = '';
    order.ticketEmailNextRetryAt = new Date();
    order.locale = this.resolveLocale(order.locale);
    await order.save();
    void this.sendTicketsEmailForOrder({
      orderId: order.id,
      force: true,
    })
      .catch(() => {
        // Retried by cron; order stays paid even if email fails.
      })
      /*
        Paid for a show the organizer cancelled while this order was still being paid:
        the payment stands (the money is already captured), and the buyer is told about
        the cancellation too — after the first go at the tickets letter, so it reads last.
      */
      .then(() => this.sessionCancellationNotifier.queueForPaidOrder(order))
      .catch((err) => {
        this.logger.warn(
          `Cancelled-session check failed for order ${orderId}: ${(err as Error).message}`,
        );
      });
    this.logger.log(`MockOrder id=${orderId} confirmed as paid`);

    /*
      Paid for a show taken off sale while this order was still being paid (its date left
      the schedule): the payment and the tickets stand. The show is listed with its sales in
      the organizer's sessions and can be cancelled there, which e-mails the buyer.
    */
    void this.eventSessionsService
      .disabledSessionIds(
        order.event,
        (order.tickets ?? [])
          .map((line) => line.session)
          .filter((session): session is number => typeof session === 'number'),
      )
      .then((disabled) => {
        if (disabled.length) {
          this.logger.warn(
            `Order ${orderId} was paid for session(s) ${disabled.join(', ')} of event ${order.event} that are off sale (disabled)`,
          );
        }
      })
      .catch((err) => {
        this.logger.warn(
          `Disabled-session check failed for order ${orderId}: ${(err as Error).message}`,
        );
      });

    void this.telegramSalesNotificationService
      .sendOrderSaleNotification(orderId)
      .catch((err) => {
        this.logger.warn(
          `Telegram sale notification failed for order ${orderId}: ${(err as Error).message}`,
        );
      });

    // Event group chat (LINE): "New ticket sale", then the sales recheck (sold out).
    void this.messengersNotifier.notifyOrderPaid(orderId).catch((err) => {
      this.logger.warn(
        `Messenger sale notification failed for order ${orderId}: ${(err as Error).message}`,
      );
    });

    // MAILCHIMP-DISABLED: newsletter not ready for prod — uncomment to re-enable
    // // Consent-gated: only orders where the checkout checkbox was ticked reach Mailchimp.
    // void this.pushNewsletterOptInForOrder(order).catch((err) => {
    //   this.logger.warn(
    //     `Mailchimp opt-in push failed for order ${orderId}: ${(err as Error).message}`,
    //   );
    // });

    try {
      const [customer, event] = await Promise.all([
        this.customersService.findById(String(order.customer)),
        this.eventsService.findOneByNumericId(order.event),
      ]);
      await this.referralLinksService.recordReferralShareIfEligible({
        customerReferralLinkId: customer?.referralLink,
        eventCreatorUserId: event.creator,
        orderId: order._id as mongoose.Types.ObjectId,
        orderPrice: order.price,
        orderTotalPrice: order.total_price,
      });
    } catch (err) {
      this.logger.error(
        `Referral share / stats update failed for order ${orderId}: ${(err as Error).message}`,
        (err as Error).stack,
      );
    }

    if (order.promoCodeId && order.promoTicketCount) {
      try {
        await this.promocodesService.incrementCustomerPromoUsage(
          order.customer,
          order.promoCodeId,
          order.promoTicketCount,
        );
      } catch (err) {
        this.logger.error(
          `Promo usage increment failed for order ${orderId}: ${(err as Error).message}`,
          (err as Error).stack,
        );
      }
    }

    return order;
  }

  // MAILCHIMP-DISABLED: newsletter not ready for prod — uncomment to re-enable
  // /**
  //  * Runs only after a successful payment. Records the consent locally (GDPR/PDPA
  //  * proof lives in our DB) and upserts the buyer into the Mailchimp audience as
  //  * 'subscribed' — the purchase email is already verified by the OTP checkout flow.
  //  */
  // private async pushNewsletterOptInForOrder(order: IMockOrder): Promise<void> {
  //   if (!order.newsletterOptIn) return;
  //   const customer = await this.customersService.findById(String(order.customer));
  //   if (!customer?.email) return;
  //   await this.customersService.setEmailMarketingConsent(customer.id, true);
  //
  //   // Event context is best-effort decoration: its absence must not lose the subscriber.
  //   let eventName = '';
  //   try {
  //     const event = await this.eventsService.findOneByNumericId(order.event);
  //     const title = event?.title;
  //     eventName = title?.en || title?.ru || title?.th || '';
  //   } catch {
  //     // deleted/hidden event — subscribe without event details
  //   }
  //
  //   await this.mailchimpService.upsertMember({
  //     email: customer.email,
  //     statusIfNew: 'subscribed',
  //     fullname: customer.fullname,
  //     language: order.locale,
  //     tags: ['buyer'],
  //     mergeFields: {
  //       EVENT_ID: order.event,
  //       ...(eventName ? { EVENT_NAME: eventName } : {}),
  //       PURCHASED: new Date().toISOString().slice(0, 10),
  //       ...(customer.phone?.trim() ? { PHONE: customer.phone.trim() } : {}),
  //     },
  //   });
  // }

  @Cron('*/1 * * * *')
  async retryFailedTicketEmails(): Promise<void> {
    const now = new Date();
    const retryOrders = await this.mockOrderModel
      .find({
        status: 'paid',
        ticketEmailStatus: 'failed',
        ticketEmailAttempts: { $lt: MAX_TICKET_EMAIL_RETRIES },
        $or: [
          { ticketEmailNextRetryAt: { $exists: false } },
          { ticketEmailNextRetryAt: { $lte: now } },
        ],
      })
      .select({ id: 1 })
      .lean()
      .exec() as Array<{ id: number }>;

    for (const order of retryOrders) {
      try {
        await this.sendTicketsEmailForOrder({
          orderId: order.id,
          force: true,
        });
      } catch {
        // Errors are stored on order and retried until max attempts.
      }
    }
  }

  /**
   * Organizer copies whose attempt failed (render or SMTP), retried until the attempts
   * run out. Only orders whose copy was actually attempted qualify: putting a copy
   * address on an existing event must not mail copies of every order it ever had.
   */
  @Cron('*/1 * * * *')
  async retryFailedTicketCopyEmails(): Promise<void> {
    const retryOrders = (await this.mockOrderModel
      .find({
        status: 'paid',
        ticketEmailStatus: 'sent',
        ticketCopyEmailSentAt: { $exists: false },
        ticketCopyEmailAttempts: { $gte: 1, $lt: MAX_TICKET_EMAIL_RETRIES },
        ticketCopyEmailNextRetryAt: { $lte: new Date() },
      })
      .select({ id: 1, event: 1, customer: 1 })
      .lean()
      .exec()) as Array<Pick<IMockOrder, 'id' | 'event' | 'customer'>>;

    for (const order of retryOrders) {
      let context: {
        customer: ICustomer | null;
        event: IEvent;
        tickets: Array<Pick<ITicket, 'id'>>;
      };
      try {
        const [customer, event, tickets] = await Promise.all([
          this.customersService.findById(String(order.customer)),
          this.eventsService.findOneByNumericId(order.event),
          this.ticketsService.findByOrderForCustomer(order.id, order.customer),
        ]);
        context = { customer, event, tickets };
      } catch (error) {
        // Not even loaded: counts as a failed attempt, so a vanished event is not retried forever.
        await this.recordTicketCopyEmailFailure(order.id, error);
        continue;
      }
      const { customer, event, tickets } = context;
      const copyTo = event.ticketCopyEmail?.trim();
      if (!copyTo || !customer || !tickets.length) {
        // The address was removed (or nothing is left to copy): stop retrying.
        await this.mockOrderModel
          .updateOne({ id: order.id }, { $unset: { ticketCopyEmailNextRetryAt: 1 } })
          .exec();
        continue;
      }
      try {
        await this.sendTicketCopyEmail({ orderId: order.id, copyTo, event, customer, tickets });
      } catch (error) {
        // Already recorded on the order by sendTicketCopyEmail.
        this.logger.warn(
          `Ticket copy email retry failed for order=${order.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /** One more failed copy attempt; `retryFailedTicketCopyEmails` picks it up after the delay. */
  private async recordTicketCopyEmailFailure(orderId: number, error: unknown): Promise<void> {
    await this.mockOrderModel
      .updateOne(
        { id: orderId },
        {
          $inc: { ticketCopyEmailAttempts: 1 },
          $set: {
            ticketCopyEmailLastError: error instanceof Error ? error.message : String(error),
            ticketCopyEmailNextRetryAt: new Date(Date.now() + TICKET_EMAIL_RETRY_MS),
          },
        },
      )
      .exec()
      .catch(() => undefined);
  }

  async resendTicketsEmail(
    orderId: number,
    customerId: number,
    locale?: string,
  ): Promise<{ ok: true; status: 'sent' }> {
    const order = await this.mockOrderModel.findOne({ id: orderId }).exec();
    if (!order) {
      throw new NotFoundException(`MockOrder with id ${orderId} not found`);
    }
    if (order.customer !== customerId) {
      throw new ForbiddenException('You can resend tickets only for your own order');
    }
    this.assertOrderPaymentConfirmed(order);

    await this.sendTicketsEmailForOrder({
      orderId: order.id,
      force: true,
      localeOverride: locale ? this.resolveLocale(locale) : undefined,
    });
    return { ok: true, status: 'sent' as const };
  }

  async manualResendTicketsToEmail(
    orderId: number,
    email: string,
    locale?: string,
  ): Promise<{ ok: true; status: 'sent'; orderId: number; sentTo: string; tickets: number }> {
    const order = await this.mockOrderModel.findOne({ id: orderId }).exec();
    if (!order) {
      throw new NotFoundException(`MockOrder with id ${orderId} not found`);
    }
    this.assertOrderPaymentConfirmed(order);

    const resolvedLocale = locale ? this.resolveLocale(locale) : this.resolveLocale(order.locale);
    const dict = TICKET_EMAIL_LOCALES[resolvedLocale];

    const [customer, event, tickets] = await Promise.all([
      this.customersService.findById(String(order.customer)),
      this.eventsService.findOneByNumericId(order.event),
      this.ticketsService.findByOrderForCustomer(order.id, order.customer),
    ]);

    if (!tickets.length) {
      throw new BadRequestException(`No issued tickets found for paid order=${order.id}`);
    }
    const buyerName = customer?.fullname?.trim() || `Customer #${order.customer}`;

    const eventTitle = this.pickLocalizedText(event.title, resolvedLocale, `Event #${event.id}`);
    const publicBaseUrl = this.getTicketPublicBaseUrl();
    const { format: ticketFormat, attachments } = await this.renderTicketAttachments({
      orderId: order.id,
      tickets,
      locale: attachedTicketLocale(resolvedLocale),
      format: resolveTicketAttachmentFormat(event),
    });

    await this.notificationService.sendEmail({
      to: email,
      ...buildTicketsEmail({
        dict,
        eventTitle,
        buyerName,
        buyerEmail: email,
        logoUrl: publicBaseUrl ? `${publicBaseUrl}/logo.png` : '',
        ticketFormat,
      }),
      attachments,
    });

    return {
      ok: true,
      status: 'sent',
      orderId: order.id,
      sentTo: email,
      tickets: tickets.length,
    };
  }

  /**
   * Marks order payment as failed (webhook from payment microservice).
   */
  async markPaymentFailed(orderId: number): Promise<IMockOrder> {
    const order = await this.mockOrderModel.findOne({ id: orderId }).exec();
    if (!order) {
      throw new NotFoundException(`MockOrder with id ${orderId} not found`);
    }
    if (order.status !== 'wait') {
      return order;
    }
    order.status = 'failed';
    await order.save();
    this.logger.log(`MockOrder id=${orderId} marked as payment failed`);
    return order;
  }

  async handleOmiseWebhook(event: OmiseEventPayload): Promise<{ ok: true }> {
    const eventKey = typeof event.key === 'string' ? event.key : '';
    if (!['charge.complete', 'charge.failed', 'charge.update'].includes(eventKey)) {
      this.logger.log(`[OmiseWebhook] Ignored event key=${eventKey || 'unknown'}`);
      return { ok: true };
    }

    const chargeId = event.data?.id;
    if (!chargeId) {
      this.logger.warn('[OmiseWebhook] Missing charge id');
      return { ok: true };
    }

    const charge = await this.omisePayment.retrieveCharge(chargeId);
    const metadata = charge.metadata ?? {};
    const rawOrderId = metadata.orderId ?? metadata.order_id;
    const orderId = typeof rawOrderId === 'number'
      ? rawOrderId
      : typeof rawOrderId === 'string'
        ? parseInt(rawOrderId, 10)
        : NaN;

    if (Number.isNaN(orderId)) {
      this.logger.warn(`[OmiseWebhook] Charge ${charge.id} has no numeric orderId metadata`);
      return { ok: true };
    }

    const order = await this.mockOrderModel.findOne({ id: orderId }).exec();
    if (!order) {
      this.logger.warn(`[OmiseWebhook] Order ${orderId} not found for charge ${charge.id}`);
      return { ok: true };
    }

    const expectedAmount = toMinorUnits(order.total_price);
    const actualCurrency = charge.currency?.toLowerCase?.() ?? '';
    if (charge.amount !== expectedAmount || actualCurrency !== 'thb') {
      this.logger.error(
        `[OmiseWebhook] Amount/currency mismatch for order ${orderId}: expected ${expectedAmount} thb, got ${charge.amount} ${charge.currency}`,
      );
      return { ok: true };
    }

    if (charge.status === 'successful') {
      try {
        await this.confirmPayment(orderId, {
          amount: charge.amount,
          currency: charge.currency?.toUpperCase?.() ?? 'THB',
          payload: {
            provider: 'omise',
            omiseChargeId: charge.id,
            omisePaymentMethod: metadata.paymentMethod,
          },
        });
        this.logger.log(`[OmiseWebhook] Order ${orderId} confirmed as paid`);
      } catch (e) {
        if (e instanceof BadRequestException) {
          this.logger.log(`[OmiseWebhook] Order ${orderId} already processed, returning 200`);
        } else {
          throw e;
        }
      }
    } else if (charge.status === 'failed' || charge.status === 'expired') {
      await this.markPaymentFailed(orderId);
      this.logger.log(`[OmiseWebhook] Order ${orderId} marked failed by Omise status=${charge.status}`);
    } else {
      this.logger.log(`[OmiseWebhook] Charge ${charge.id} status=${charge.status}; no order change`);
    }

    return { ok: true };
  }

  /**
   * Manual cancellation from customer checkout flow.
   * Customer can cancel only their own pending (wait) order.
   */
  async cancelByCustomer(orderId: number, customerId: number): Promise<IMockOrder> {
    const order = await this.mockOrderModel.findOne({ id: orderId }).exec();
    if (!order) {
      throw new NotFoundException(`MockOrder with id ${orderId} not found`);
    }
    if (order.customer !== customerId) {
      throw new ForbiddenException('You can cancel only your own order');
    }
    if (order.status === 'paid') {
      throw new BadRequestException(`Order ${orderId} cannot be cancelled: already paid`);
    }
    if (order.status !== 'wait') {
      return order;
    }
    order.status = 'failed';
    await order.save();
    this.logger.log(`MockOrder id=${orderId} cancelled by customer=${customerId}`);
    return order;
  }

  /**
   * Paid mock orders only: sums by event and payment method (RUB/KZT, THB, USDT).
   * An optional show-date period / session narrows it to those shows (see
   * `aggregateEventPaidSalesStatistics`); without one the output is unchanged.
   */
  async getEventPaidSalesStatistics(
    eventId: number,
    creatorUserId: string,
    period?: SessionPeriodFilter,
  ): Promise<MockOrderEventSalesStatistics> {
    const filter = normalizeSessionPeriodFilter(period);
    await this.eventsService.findOne(String(eventId), creatorUserId);
    return this.aggregateEventPaidSalesStatistics(eventId, filter);
  }

  /**
   * Same as getEventPaidSalesStatistics without creator ownership check (admin),
   * including the optional show-date period / session.
   */
  async getEventPaidSalesStatisticsAdmin(
    eventId: number,
    period?: SessionPeriodFilter,
  ): Promise<MockOrderEventSalesStatistics> {
    const filter = normalizeSessionPeriodFilter(period);
    await this.eventsService.findEventByNumericId(String(eventId));
    return this.aggregateEventPaidSalesStatistics(eventId, filter);
  }

  private async aggregateEventPaidSalesStatistics(
    eventId: number,
    period: SessionPeriodFilter | null = null,
  ): Promise<MockOrderEventSalesStatistics> {
    const event = await this.eventsService.findOneByNumericId(eventId);
    const feeRates = eventFeeRatesFromPercents(resolveEventFeePercents(event));

    /*
      Show-date period: only paid orders with a ticket line of the period's shows, and
      every money field of such an order scaled by its share of the period
      (`periodShareExpr`: matching lines' price×count over all lines'). The buckets
      below — and the processing/platform fees derived from `sum_price` — are then
      computed exactly as without a period, on the scaled amounts.
    */
    const scope = period
      ? await this.eventSessionsService.resolvePeriodScope(event, period)
      : null;
    const scaleByShare = (field: string) => ({
      $multiply: [{ $ifNull: [`$${field}`, 0] }, '$__periodShare'],
    });
    const periodStages: mongoose.PipelineStage[] = scope
      ? [
          { $addFields: { __periodShare: periodShareExpr(scope) } },
          {
            $addFields: {
              total_price: { $multiply: ['$total_price', '$__periodShare'] },
              price: { $multiply: ['$price', '$__periodShare'] },
              vat: scaleByShare('vat'),
              additionalTicketCostFee: scaleByShare('additionalTicketCostFee'),
              bankCardFee: scaleByShare('bankCardFee'),
              cashFee: scaleByShare('cashFee'),
            },
          },
        ]
      : [];

    const paidOrderAmountGroup = {
      $group: {
        _id: null as null,
        sum_total_price: { $sum: '$total_price' },
        sum_price: { $sum: '$price' },
        sum_vat: { $sum: { $ifNull: ['$vat', 0] } },
        sum_additional_cost_fee: { $sum: { $ifNull: ['$additionalTicketCostFee', 0] } },
        sum_bank_card_fee: { $sum: { $ifNull: ['$bankCardFee', 0] } },
        sum_cash_fee: { $sum: { $ifNull: ['$cashFee', 0] } },
      },
    };

    type AggRow = {
      sum_total_price: number;
      sum_price: number;
      sum_vat: number;
      sum_additional_cost_fee: number;
      sum_bank_card_fee: number;
      sum_cash_fee: number;
    };
    const facetResult = await this.mockOrderModel
      .aggregate<{
        general: AggRow[];
        sbp_rub_kzt: AggRow[];
        qr_thb_old: AggRow[];
        qr_thb_omise: AggRow[];
        card_omise: AggRow[];
        alipay_omise: AggRow[];
        crypto_usdt: AggRow[];
        cash: AggRow[];
      }>([
        {
          $match: {
            event: eventId,
            status: 'paid',
            ...(scope ? periodLinesQuery(scope, 'tickets') : {}),
          },
        },
        ...periodStages,
        {
          $facet: {
            general: [paidOrderAmountGroup],
            sbp_rub_kzt: [
              { $match: { paymentCurrency: { $in: ['RUB', 'KZT'] } } },
              paidOrderAmountGroup,
            ],
            // Legacy THB orders never had `paymentMethod` set, so anything that is not an
            // Omise method (or cash) belongs to the old bank account. `$nin` also matches
            // documents where the field is missing.
            qr_thb_old: [
              {
                $match: {
                  paymentCurrency: 'THB',
                  paymentMethod: { $nin: ['QR', 'ALIPAY', 'CARD', 'CASH'] },
                },
              },
              paidOrderAmountGroup,
            ],
            qr_thb_omise: [
              { $match: { paymentCurrency: 'THB', paymentMethod: 'QR' } },
              paidOrderAmountGroup,
            ],
            card_omise: [
              { $match: { paymentCurrency: 'THB', paymentMethod: 'CARD' } },
              paidOrderAmountGroup,
            ],
            alipay_omise: [
              { $match: { paymentCurrency: 'THB', paymentMethod: 'ALIPAY' } },
              paidOrderAmountGroup,
            ],
            crypto_usdt: [{ $match: { paymentCurrency: 'USDT' } }, paidOrderAmountGroup],
            cash: [{ $match: { paymentMethod: 'CASH' } }, paidOrderAmountGroup],
          },
        },
      ])
      .exec();

    const row = facetResult[0];
    const pack = (rows: AggRow[] | undefined): MockOrderSalesStatsBucket => {
      const first = rows?.[0];
      return this.buildMockOrderSalesStatsBucket(
        first?.sum_total_price ?? 0,
        first?.sum_price ?? 0,
        feeRates,
        {
          sumVat: first?.sum_vat ?? 0,
          sumAdditionalCostFee: first?.sum_additional_cost_fee ?? 0,
          sumBankCardFee: first?.sum_bank_card_fee ?? 0,
          sumCashFee: first?.sum_cash_fee ?? 0,
        },
      );
    };

    return {
      general: { all: pack(row?.general) },
      byPaymentMethod: {
        sbp_rub_kzt: pack(row?.sbp_rub_kzt),
        qr_thb_old: pack(row?.qr_thb_old),
        qr_thb_omise: pack(row?.qr_thb_omise),
        card_omise: pack(row?.card_omise),
        alipay_omise: pack(row?.alipay_omise),
        crypto_usdt: pack(row?.crypto_usdt),
        cash: pack(row?.cash),
      },
    };
  }

  async findPaidMockOrdersForEventPaged(
    eventId: number,
    query: MockOrdersPaidListQueryDto,
    creatorUserId: string,
  ): Promise<MockOrderEventPaidListResponse> {
    await this.eventsService.findOne(String(eventId), creatorUserId);
    return this.findPaidMockOrdersForEventPagedCore(eventId, query);
  }

  /** Same as findPaidMockOrdersForEventPaged without creator ownership check (admin). */
  async findPaidMockOrdersForEventPagedAdmin(
    eventId: number,
    query: MockOrdersPaidListQueryDto,
  ): Promise<MockOrderEventPaidListResponse> {
    await this.eventsService.findEventByNumericId(String(eventId));
    return this.findPaidMockOrdersForEventPagedCore(eventId, query);
  }

  private escapePaidOrdersFilterRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private async buildPaidOrdersEventFilter(
    eventId: number,
    query: MockOrdersPaidListQueryDto,
  ): Promise<Record<string, unknown> | null> {
    const filter: Record<string, unknown> = {
      event: eventId,
      status: { $in: ['paid', 'refunded'] },
    };

    const orderIdTerm = query.orderId?.trim();
    if (orderIdTerm) {
      const orderIdRegex = new RegExp(this.escapePaidOrdersFilterRegex(orderIdTerm), 'i');
      filter.$expr = {
        $regexMatch: { input: { $toString: '$id' }, regex: orderIdRegex },
      };
    }

    const emailTerm = query.email?.trim();
    const customerNameTerm = query.customerName?.trim();
    if (emailTerm || customerNameTerm) {
      const customerFilter: Record<string, unknown> = {};
      if (emailTerm) {
        customerFilter.email = new RegExp(this.escapePaidOrdersFilterRegex(emailTerm), 'i');
      }
      if (customerNameTerm) {
        customerFilter.fullname = new RegExp(
          this.escapePaidOrdersFilterRegex(customerNameTerm),
          'i',
        );
      }

      const customers = await this.customerModel
        .find(customerFilter)
        .select('id')
        .lean()
        .exec();
      const customerIds = customers.map((c) => c.id);
      if (customerIds.length === 0) {
        return null;
      }
      filter.customer = { $in: customerIds };
    }

    return filter;
  }

  /**
   * Which paid/refunded orders a show-date period keeps: those with a ticket line of
   * the period's shows. A refunded order has no lines left, so it is matched by the
   * tickets frozen at its refund (`refundedTickets`; refunds completed before that
   * snapshot existed cannot be matched). A one-off event is a single show: inside the
   * period every order of it stays (`null` = no extra condition), outside none does.
   */
  private paidOrdersPeriodCondition(
    event: Pick<IEvent, 'recurrence'>,
    scope: SessionPeriodScope,
  ): Record<string, unknown> | null {
    if (event.recurrence?.enabled !== true && scope.sessionlessMatch) return null;
    return {
      $or: [periodLinesQuery(scope, 'tickets'), periodLinesQuery(scope, 'refundedTickets')],
    };
  }

  private async findPaidMockOrdersForEventPagedCore(
    eventId: number,
    query: MockOrdersPaidListQueryDto,
  ): Promise<MockOrderEventPaidListResponse> {
    const page = query.page != null && query.page >= 1 ? query.page : 1;
    const limit =
      query.limit != null && query.limit >= 1 && query.limit <= 100 ? query.limit : 20;
    const skip = (page - 1) * limit;

    const period = normalizeSessionPeriodFilter(query);
    const filter = await this.buildPaidOrdersEventFilter(eventId, query);
    if (filter == null) {
      return { page, limit, total: 0, totalPages: 0, rows: [] };
    }

    const event = await this.eventsService.findOneByNumericId(eventId);
    if (period) {
      const scope = await this.eventSessionsService.resolvePeriodScope(event, period);
      const periodCondition = this.paidOrdersPeriodCondition(event, scope);
      if (periodCondition) {
        filter.$and = [...((filter.$and as unknown[]) ?? []), periodCondition];
      }
    }

    const [total, orders] = await Promise.all([
      this.mockOrderModel.countDocuments(filter).exec(),
      this.mockOrderModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select([
          'id',
          'createdAt',
          'status',
          'total_price',
          'price',
          'vat',
          'additionalTicketCostFee',
          'bankCardFee',
          'cashFee',
          'paymentCurrency',
          'paymentMethod',
          'originalPaidAmount',
          'tickets',
          'customer',
          'promocodeDiscount',
          'refundStatus',
          'refundStatusChangedByEmail',
          'refund',
          'selectedPos',
          'actualPos',
          'cashierEmail',
          'paymentConfirmedAt',
        ])
        .lean()
        .exec(),
    ]);

    const feeRates = eventFeeRatesFromPercents(resolveEventFeePercents(event));

    const customerIds = [...new Set(orders.map((o) => o.customer))];
    const customerById = await this.loadCustomerNameEmailById(customerIds);

    const rows: MockOrderEventPaidListRow[] = orders.map((o) =>
      this.mapOrderToPaidListRow(
        o as IMockOrder,
        feeRates,
        customerById.get(o.customer) ?? { name: '', email: '' },
      ),
    );

    const totalPages = total === 0 ? 0 : Math.ceil(total / limit);

    return { page, limit, total, totalPages, rows };
  }

  async getMockOrderRefundDetailsAdmin(orderId: number): Promise<MockOrderRefundDetailsResponse> {
    const order = await this.mockOrderModel.findOne({ id: orderId }).lean().exec();
    if (!order) {
      throw new NotFoundException(`MockOrder with id ${orderId} not found`);
    }
    if (order.status !== 'paid' && order.status !== 'refunded') {
      throw new BadRequestException('refund_available_only_for_paid_or_refunded_orders');
    }

    const [event, customer] = await Promise.all([
      this.eventsService.findOneByNumericId(order.event),
      this.customerModel.findOne({ id: order.customer }).select('fullname').lean().exec(),
    ]);

    const feeRates = eventFeeRatesFromPercents(resolveEventFeePercents(event));
    const liveCalculation = buildRefundCalculation(order as IMockOrder, feeRates);
    const calculation =
      order.refund != null ? refundSnapshotToCalculation(order.refund) : liveCalculation;
    const supportMessage = buildRefundSupportMessage(order.id, calculation);

    const ticketCount = (order.tickets ?? []).reduce(
      (acc, ticket) => acc + (ticket.count || 0),
      0,
    );
    const created = order.createdAt instanceof Date ? order.createdAt : new Date(order.createdAt);

    return {
      orderId: order.id,
      buyerName: (customer as { fullname?: string } | null)?.fullname?.trim() ?? '',
      ticketCount,
      eventId: order.event,
      eventTitle: this.pickLocalizedEventTitle(event.title),
      purchasedAt: created.toISOString(),
      orderStatus: order.status,
      paymentMethod:
        order.paymentMethod === 'CASH'
          ? 'Cash'
          : resolvePaymentMethodLabel(order.paymentCurrency, order.paymentMethod),
      paymentCurrency: order.paymentCurrency,
      originalPaidAmount:
        order.originalPaidAmount != null ? Number(order.originalPaidAmount) : null,
      grossAmountTHB: calculation.grossAmountTHB,
      totalCommissionTHB: calculation.totalCommissionTHB,
      refundAmount: calculation.refundAmount,
      refundStatus: order.refundStatus,
      refundCreatedAt: order.refund?.createdAt
        ? new Date(order.refund.createdAt).toISOString()
        : null,
      refundCompletedAt: order.refund?.completedAt
        ? new Date(order.refund.completedAt).toISOString()
        : null,
      refundStatusChangedByEmail: order.refundStatusChangedByEmail ?? null,
      calculation,
      supportMessage,
      refund: order.refund ?? null,
    };
  }

  async exportPaidMockOrdersCsvForEventAdmin(eventId: number): Promise<string> {
    await this.eventsService.findEventByNumericId(String(eventId));

    const orders = await this.mockOrderModel
      .find({ event: eventId, status: { $in: ['paid', 'refunded'] } })
      .sort({ createdAt: -1 })
      .select([
        'id',
        'createdAt',
        'status',
        'total_price',
        'price',
        'vat',
        'additionalTicketCostFee',
        'bankCardFee',
        'cashFee',
        'paymentCurrency',
        'paymentMethod',
        'originalPaidAmount',
        'tickets',
        'customer',
        'promocodeDiscount',
        'refundStatus',
        'refundStatusChangedByEmail',
        'refund',
        'selectedPos',
        'actualPos',
        'cashierEmail',
        'paymentConfirmedAt',
      ])
      .lean()
      .exec();

    const event = await this.eventsService.findOneByNumericId(eventId);
    const feeRates = eventFeeRatesFromPercents(resolveEventFeePercents(event));

    const customerIds = [...new Set(orders.map((o) => o.customer))];
    const customerById = await this.loadCustomerNameEmailById(customerIds);

    const rows = orders.map((o) =>
      this.mapOrderToPaidListRow(
        o as IMockOrder,
        feeRates,
        customerById.get(o.customer) ?? { name: '', email: '' },
      ),
    );

    const headers = [
      'Order ID',
      'Order Status',
      'Created At',
      'Buyer',
      'Payment Method',
      'Gross (THB)',
      'Promo Discount',
      'Processing Fees',
      'Platform Fee',
      'VAT',
      'Additional Fee Per Ticket',
      'Bank Card Fee',
      'Cash Fee',
      'Net Payout',
      'Refund Status',
      'Refund Amount',
      'Refund Currency',
      'Refund Created At',
      'Refund Completed At',
      'Refund Changed By',
    ];

    const csvRows = rows.map((row) => [
      row.id,
      row.status,
      row.createdAt,
      row.customerName,
      row.paymentMethod,
      row.total_price,
      row.promocodeDiscount ?? '',
      row.processing_fee,
      row.platform_fee,
      row.vat_fee,
      row.additional_ticket_cost_fee,
      row.bank_card_fee,
      row.cash_fee,
      row.net_payout,
      row.refundStatus,
      row.refundAmount ?? '',
      row.refundCurrency ?? '',
      row.refundCreatedAt ?? '',
      row.refundCompletedAt ?? '',
      row.refundStatusChangedByEmail ?? '',
    ]);

    return [headers, ...csvRows].map((line) => line.map((cell) => this.escapeCsvCell(cell)).join(',')).join('\n');
  }

  private async loadCustomerNameEmailById(
    customerIds: number[],
  ): Promise<Map<number, { name: string; email: string }>> {
    const customerById = new Map<number, { name: string; email: string }>();
    if (!customerIds.length) {
      return customerById;
    }

    const customers = await this.customerModel
      .find({ id: { $in: customerIds } })
      .select('id fullname email')
      .lean()
      .exec();
    for (const c of customers as Array<{ id: number; fullname?: string; email?: string }>) {
      customerById.set(c.id, {
        name: (c.fullname ?? '').trim(),
        email: (c.email ?? '').trim(),
      });
    }

    return customerById;
  }

  private mapOrderToPaidListRow(
    order: IMockOrder,
    feeRates: ReturnType<typeof eventFeeRatesFromPercents>,
    customer: { name: string; email: string },
  ): MockOrderEventPaidListRow {
    const price = Number(order.price) || 0;
    const totalPrice = Number(order.total_price) || 0;
    const processingFee = price * feeRates.processingFeeRate;
    const platformFee = price * feeRates.platformFeeRate;
    const created =
      order.createdAt instanceof Date ? order.createdAt : new Date(order.createdAt as string);
    const vatFee = Number(order.vat) || 0;
    const additionalAmt = Number(order.additionalTicketCostFee) || 0;
    const bankCardFee = Number(order.bankCardFee) || 0;
    const cashFee = Number(order.cashFee) || 0;
    const ticketCount = (order.tickets ?? []).reduce(
      (acc, ticket) => acc + (ticket.count || 0),
      0,
    );

    return {
      id: order.id,
      createdAt: created.toISOString(),
      status: order.status,
      total_price: totalPrice,
      price,
      paymentCurrency: order.paymentCurrency,
      paymentMethod: order.paymentMethod === 'CASH' ? 'CASH' : resolvePaymentMethodLabel(order.paymentCurrency, order.paymentMethod),
      originalPaidAmount:
        order.originalPaidAmount != null ? Number(order.originalPaidAmount) : null,
      numberOfTheTickets: ticketCount,
      customerName: customer.name,
      email: customer.email,
      promocodeDiscount: order.promocodeDiscount ?? null,
      processing_fee: processingFee,
      platform_fee: platformFee,
      vat_fee: vatFee,
      additional_ticket_cost_fee: additionalAmt,
      bank_card_fee: bankCardFee,
      cash_fee: cashFee,
      // Комиссия за наличные — доход платформы, в net_payout организатора не входит.
      net_payout: price - processingFee - platformFee,
      tickets: order.tickets ?? [],
      refundStatus: order.refundStatus,
      refundStatusChangedByEmail: order.refundStatusChangedByEmail,
      refundAmount: order.refund?.refundAmount ?? null,
      refundCurrency: order.refund?.originalCurrency ?? null,
      refundCreatedAt: order.refund?.createdAt
        ? new Date(order.refund.createdAt).toISOString()
        : null,
      refundCompletedAt: order.refund?.completedAt
        ? new Date(order.refund.completedAt).toISOString()
        : null,
      selected_pos: order.paymentMethod === 'CASH' ? order.selectedPos ?? null : undefined,
      actual_pos: order.paymentMethod === 'CASH' ? order.actualPos ?? null : undefined,
      cashier_email: order.paymentMethod === 'CASH' ? order.cashierEmail ?? null : undefined,
      payment_confirmed_at:
        order.paymentMethod === 'CASH' && order.paymentConfirmedAt
          ? new Date(order.paymentConfirmedAt).toISOString()
          : order.paymentMethod === 'CASH'
            ? null
            : undefined,
    };
  }

  private pickLocalizedEventTitle(title: { en?: string; th?: string; ru?: string }): string {
    const candidates = [title.en, title.th, title.ru].map((value) =>
      typeof value === 'string' ? value.trim() : '',
    );
    return candidates.find(Boolean) ?? '';
  }

  private escapeCsvCell(value: string | number): string {
    const text = String(value ?? '');
    if (/[",\n\r]/.test(text)) {
      return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
  }

  private buildMockOrderSalesStatsBucket(
    sumTotalPrice: number,
    sumPrice: number,
    feeRates: { processingFeeRate: number; platformFeeRate: number },
    lineSums: {
      sumVat: number;
      sumAdditionalCostFee: number;
      sumBankCardFee: number;
      sumCashFee: number;
    },
  ): MockOrderSalesStatsBucket {
    const sumProcessingFee = sumPrice * feeRates.processingFeeRate;
    const sumPlatformFee = sumPrice * feeRates.platformFeeRate;
    return {
      sum_total_price: sumTotalPrice,
      sum_price: sumPrice,
      sum_processing_fee: sumProcessingFee,
      sum_platform_fee: sumPlatformFee,
      sum_vat_fee: lineSums.sumVat,
      sum_additional_ticket_cost_fee: lineSums.sumAdditionalCostFee,
      sum_bank_card_fee: lineSums.sumBankCardFee,
      sum_cash_fee: lineSums.sumCashFee,
      // Комиссия за наличные — доход платформы, к выплате организатору не идёт.
      sum_net_payout: sumPrice - sumProcessingFee - sumPlatformFee,
    };
  }
}
