import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import mongoose from 'mongoose';
import { EventsService } from '../events/events.service';
import { CheckPromoCodeForTicketDto } from './dto/check-promo-code-for-ticket.dto';
import { CreatePromoCodeDto } from './dto/create-promo-code.dto';
import { PromoCodeResponseDto } from './dto/promo-code-response.dto';
import { PromoCodeTicketCheckResponseDto } from './dto/promo-code-ticket-check-response.dto';
import { PromoCodeStatisticsDto } from './dto/promo-code-statistics.dto';
import { UpdatePromoCodeDto } from './dto/update-promo-code.dto';
import { PROMO_CODE_TICKET_CHECK_ERROR } from './constants/promo-code-ticket-check.constants';
import {
  CustomerPromoCodeUsageSchema,
  ICustomerPromoCodeUsage,
} from './schemas/customer-promo-code-usage.schema';
import { IPromoCode, PromoCodeSchema } from './schemas/promo-code.schema';
import { IMockOrder, MockOrderSchema } from '../mock-orders/schemas/mock-order.schema';
import { CustomerSchema, ICustomer } from '../customers/schemas/customer.schema';
import {
  EventSchema,
  IEvent,
  ILocalizedText,
} from '../events/schemas/event.schema';
import { PromoOrdersHistoryResponseDto } from './dto/promo-orders-history-response.dto';

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readMaxTicketsCountByCustomer(p: Record<string, unknown>): number {
  const n = p.maxTicketsCountByCustomer;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

function readMaxTicketsCountTotal(p: Record<string, unknown>): number {
  const n = p.maxTicketsCountTotal;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

function readCurrentTicketsCountTotal(p: Record<string, unknown>): number {
  const n = p.currentTicketsCountTotal;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

function toResponse(doc: IPromoCode): PromoCodeResponseDto {
  const o = doc.toObject ? doc.toObject() : doc;
  const raw = o as Record<string, unknown>;
  const id = (o as { _id: mongoose.Types.ObjectId })._id.toString();
  return {
    id,
    internalName: o.internalName,
    assignedTo: o.assignedTo,
    promoCode: o.promoCode,
    discountType: o.discountType,
    discountValue: o.discountValue,
    expirationDate: o.expirationDate,
    maxTicketsCountByCustomer: readMaxTicketsCountByCustomer(raw),
    maxTicketsCountTotal: readMaxTicketsCountTotal(raw),
    currentTicketsCountTotal: readCurrentTicketsCountTotal(raw),
    applyToAllEvents: o.applyToAllEvents,
    applicableEventIds: o.applicableEventIds,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
}

function pickLocalizedString(t?: ILocalizedText): string {
  if (!t) return '';
  return (t.en ?? t.th ?? t.ru ?? '').trim();
}

type LeanOrderForHistory = Pick<
  IMockOrder,
  'id' | 'event' | 'customer' | 'createdAt' | 'promoTicketCount' | 'tickets'
>;

function ticketCountForHistoryOrder(order: LeanOrderForHistory): number {
  if (order.promoTicketCount != null && order.promoTicketCount >= 1) {
    return order.promoTicketCount;
  }
  return (order.tickets ?? []).reduce((sum, line) => sum + (line.count ?? 0), 0);
}

@Injectable()
export class PromocodesService {
  constructor(private readonly eventsService: EventsService) {}

  private normalizeAssignedEventIds(assignedEventIds?: number[]): string[] | undefined {
    if (!Array.isArray(assignedEventIds)) {
      return undefined;
    }
    return Array.from(
      new Set(
        assignedEventIds
          .filter((eventId) => Number.isInteger(eventId) && eventId > 0)
          .map((eventId) => String(eventId)),
      ),
    );
  }

  private isPromoAccessibleForAssignedEvents(
    promo: Pick<IPromoCode, 'applyToAllEvents' | 'applicableEventIds'>,
    assignedEventIds?: number[],
  ): boolean {
    const normalizedAssignedIds = this.normalizeAssignedEventIds(assignedEventIds);
    if (normalizedAssignedIds === undefined) {
      return true;
    }
    if (normalizedAssignedIds.length === 0) {
      return false;
    }
    if (promo.applyToAllEvents) {
      return true;
    }
    const applicable = (promo.applicableEventIds ?? []).map((eventId) => String(eventId));
    return applicable.some((eventId) => normalizedAssignedIds.includes(eventId));
  }

  private get promoCodeModel(): mongoose.Model<IPromoCode> {
    return (
      (mongoose.models.PromoCode as mongoose.Model<IPromoCode>) ??
      mongoose.model<IPromoCode>('PromoCode', PromoCodeSchema)
    );
  }

  private get customerPromoUsageModel(): mongoose.Model<ICustomerPromoCodeUsage> {
    return (
      (mongoose.models
        .CustomerPromoCodeUsage as mongoose.Model<ICustomerPromoCodeUsage>) ??
      mongoose.model<ICustomerPromoCodeUsage>(
        'PromoCodeCustomerUsage',
        CustomerPromoCodeUsageSchema,
      )
    );
  }

  private get mockOrderModel(): mongoose.Model<IMockOrder> {
    return (
      (mongoose.models.MockOrder as mongoose.Model<IMockOrder>) ??
      mongoose.model<IMockOrder>('MockOrder', MockOrderSchema)
    );
  }

  private get customerModel(): mongoose.Model<ICustomer> {
    return (
      (mongoose.models.Customer as mongoose.Model<ICustomer>) ??
      mongoose.model<ICustomer>('Customer', CustomerSchema)
    );
  }

  private get eventModel(): mongoose.Model<IEvent> {
    return (
      (mongoose.models.Event as mongoose.Model<IEvent>) ??
      mongoose.model<IEvent>('Event', EventSchema)
    );
  }

  async create(
    dto: CreatePromoCodeDto,
    userId: string,
  ): Promise<PromoCodeResponseDto> {
    const ownerId = Number(userId);
    const promoCode = dto.promoCode.trim();

    let created: IPromoCode;
    try {
      created = await this.promoCodeModel.create({
        userId: ownerId,
        internalName: dto.internalName.trim(),
        assignedTo: dto.assignedTo?.trim() || undefined,
        promoCode,
        discountType: dto.discountType,
        discountValue: dto.discountValue,
        expirationDate: new Date(dto.expirationDate),
        maxTicketsCountByCustomer: dto.maxTicketsCountByCustomer,
        maxTicketsCountTotal: dto.maxTicketsCountTotal,
        currentTicketsCountTotal: 0,
        applyToAllEvents: dto.applyToAllEvents,
        applicableEventIds: dto.applyToAllEvents ? undefined : dto.applicableEventIds,
      });
    } catch (e: unknown) {
      const err = e as { code?: number };
      if (err.code === 11000) {
        throw new ConflictException('Promo code with this code already exists');
      }
      throw e;
    }
    return toResponse(created);
  }

  async findAll(userId: string, assignedEventIds?: number[]): Promise<PromoCodeResponseDto[]> {
    const ownerId = Number(userId);
    const rows = await this.promoCodeModel
      .find({ userId: ownerId })
      .sort({ createdAt: -1 })
      .exec();
    return rows
      .filter((row) => this.isPromoAccessibleForAssignedEvents(row, assignedEventIds))
      .map((d) => toResponse(d));
  }

  async findStatistics(userId: string, assignedEventIds?: number[]): Promise<PromoCodeStatisticsDto[]> {
    const ownerId = Number(userId);
    const promosRaw = await this.promoCodeModel
      .find({ userId: ownerId })
      .sort({ createdAt: -1 })
      .lean()
      .exec();
    const promos = promosRaw.filter((promo) =>
      this.isPromoAccessibleForAssignedEvents(
        promo as Pick<IPromoCode, 'applyToAllEvents' | 'applicableEventIds'>,
        assignedEventIds,
      ),
    );

    if (promos.length === 0) {
      return [];
    }

    const now = Date.now();
    return promos.map((p) => {
      const raw = p as unknown as Record<string, unknown>;
      const usageCount = readCurrentTicketsCountTotal(raw);

      const expiresAt = new Date(p.expirationDate);
      const expired =
        Number.isNaN(expiresAt.getTime()) || now > expiresAt.getTime();
      const status: PromoCodeStatisticsDto['status'] = expired
        ? 'EXPIRED'
        : 'ACTIVE';

      return {
        code: p.promoCode,
        internalLabel: p.internalName,
        discountType: p.discountType === 'percentage' ? 'PERCENT' : 'FIXED',
        value: p.discountValue,
        usageCount,
        maxTicketsCountTotal: readMaxTicketsCountTotal(raw),
        maxTicketsCountByCustomer: readMaxTicketsCountByCustomer(raw),
        expiresAt: expiresAt.toISOString(),
        status,
      };
    });
  }

  /**
   * Paid mock orders that used this promo (`promoCodeId` on the order).
   */
  async findOrdersHistoryByPromoCode(
    promoId: string,
    userId: string,
    pageRaw?: number,
    limitRaw?: number,
    assignedEventIds?: number[],
  ): Promise<PromoOrdersHistoryResponseDto> {
    if (!mongoose.Types.ObjectId.isValid(promoId)) {
      throw new NotFoundException('Promo code not found');
    }
    const ownerId = Number(userId);
    const owned = await this.promoCodeModel
      .findOne({ _id: promoId, userId: ownerId })
      .select('_id applyToAllEvents applicableEventIds')
      .lean()
      .exec();
    if (!owned) {
      throw new NotFoundException('Promo code not found');
    }
    if (
      !this.isPromoAccessibleForAssignedEvents(
        owned as Pick<IPromoCode, 'applyToAllEvents' | 'applicableEventIds'>,
        assignedEventIds,
      )
    ) {
      throw new NotFoundException('Promo code not found');
    }

    const page = pageRaw != null && pageRaw >= 1 ? pageRaw : 1;
    const limit =
      limitRaw != null && limitRaw >= 1 && limitRaw <= 100 ? limitRaw : 20;
    const skip = (page - 1) * limit;

    const normalizedAssignedIds = this.normalizeAssignedEventIds(assignedEventIds);
    const filter: Record<string, unknown> = { promoCodeId: promoId, status: 'paid' as const };
    if (normalizedAssignedIds !== undefined) {
      if (!normalizedAssignedIds.length) {
        return { items: [], total: 0, page, limit };
      }
      filter.event = { $in: normalizedAssignedIds.map((eventId) => Number(eventId)) };
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
          'event',
          'customer',
          'createdAt',
          'promoTicketCount',
          'tickets',
        ])
        .lean()
        .exec(),
    ]);

    const customerIds = [...new Set(orders.map((o) => o.customer))];
    const eventIds = [...new Set(orders.map((o) => o.event))];

    const [customers, events] = await Promise.all([
      customerIds.length
        ? this.customerModel
            .find({ id: { $in: customerIds } })
            .select('id fullname')
            .lean()
            .exec()
        : Promise.resolve([]),
      eventIds.length
        ? this.eventModel
            .find({ id: { $in: eventIds } })
            .select('id title')
            .lean()
            .exec()
        : Promise.resolve([]),
    ]);

    const nameByCustomerId = new Map<number, string>();
    for (const c of customers as Array<{ id: number; fullname?: string }>) {
      nameByCustomerId.set(c.id, (c.fullname ?? '').trim());
    }

    const titleByEventId = new Map<number, string>();
    for (const e of events as Array<{ id: number; title?: ILocalizedText }>) {
      titleByEventId.set(e.id, pickLocalizedString(e.title));
    }

    const items = orders.map((o) => ({
      orderId: o.id,
      customerId: o.customer,
      customerName: nameByCustomerId.get(o.customer) ?? '',
      eventId: o.event,
      eventName: titleByEventId.get(o.event) ?? '',
      date: o.createdAt.toISOString(),
      ticketCount: ticketCountForHistoryOrder(o as LeanOrderForHistory),
    }));

    return { items, total, page, limit };
  }

  async findOne(id: string, userId: string, assignedEventIds?: number[]): Promise<PromoCodeResponseDto> {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Promo code not found');
    }
    const ownerId = Number(userId);
    const doc = await this.promoCodeModel
      .findOne({ _id: id, userId: ownerId })
      .exec();
    if (!doc) {
      throw new NotFoundException('Promo code not found');
    }
    if (!this.isPromoAccessibleForAssignedEvents(doc, assignedEventIds)) {
      throw new NotFoundException('Promo code not found');
    }
    return toResponse(doc);
  }

  async update(
    id: string,
    userId: string,
    dto: UpdatePromoCodeDto,
  ): Promise<PromoCodeResponseDto> {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Promo code not found');
    }
    const ownerId = Number(userId);
    const existing = await this.promoCodeModel
      .findOne({ _id: id, userId: ownerId })
      .exec();
    if (!existing) {
      throw new NotFoundException('Promo code not found');
    }

    const existingRaw = existing.toObject() as unknown as Record<string, unknown>;
    const currentRedeemed = readCurrentTicketsCountTotal(existingRaw);
    if (currentRedeemed > 0) {
      throw new BadRequestException(
        'Cannot update a promo code after it has been used for ticket purchases',
      );
    }
    if (
      dto.maxTicketsCountTotal !== undefined &&
      dto.maxTicketsCountTotal < currentRedeemed
    ) {
      throw new BadRequestException(
        'maxTicketsCountTotal cannot be less than tickets already purchased with this promo',
      );
    }

    const mergedDiscountType = dto.discountType ?? existing.discountType;
    const mergedDiscountValue = dto.discountValue ?? existing.discountValue;
    if (mergedDiscountType === 'percentage' && mergedDiscountValue > 100) {
      throw new BadRequestException('Percentage discount cannot exceed 100');
    }

    let mergedApplyAll =
      dto.applyToAllEvents !== undefined
        ? dto.applyToAllEvents
        : existing.applyToAllEvents;
    const mergedEventIds =
      dto.applicableEventIds !== undefined
        ? dto.applicableEventIds
        : existing.applicableEventIds;
    if (
      dto.applyToAllEvents === true &&
      dto.applicableEventIds !== undefined &&
      dto.applicableEventIds.length > 0
    ) {
      throw new BadRequestException(
        'Cannot list specific events when applyToAllEvents is true',
      );
    }
    if (
      dto.applicableEventIds !== undefined &&
      dto.applicableEventIds.length > 0 &&
      dto.applyToAllEvents !== true
    ) {
      mergedApplyAll = false;
    }
    if (!mergedApplyAll && (!mergedEventIds || mergedEventIds.length === 0)) {
      throw new BadRequestException(
        'When not applying to all events, applicableEventIds must contain at least one id',
      );
    }

    if (dto.promoCode !== undefined) {
      const code = dto.promoCode.trim();
      const conflict = await this.promoCodeModel
        .findOne({ promoCode: code, _id: { $ne: existing._id } })
        .exec();
      if (conflict) {
        throw new ConflictException('Promo code with this code already exists');
      }
    }

    const $set: Record<string, unknown> = {};

    if (dto.internalName !== undefined) {
      $set.internalName = dto.internalName.trim();
    }
    if (dto.assignedTo !== undefined) {
      $set.assignedTo = dto.assignedTo.trim() || undefined;
    }
    if (dto.promoCode !== undefined) {
      $set.promoCode = dto.promoCode.trim();
    }
    if (dto.discountType !== undefined) {
      $set.discountType = dto.discountType;
    }
    if (dto.discountValue !== undefined) {
      $set.discountValue = dto.discountValue;
    }
    if (dto.expirationDate !== undefined) {
      $set.expirationDate = new Date(dto.expirationDate);
    }
    if (dto.maxTicketsCountByCustomer !== undefined) {
      $set.maxTicketsCountByCustomer = dto.maxTicketsCountByCustomer;
    }
    if (dto.maxTicketsCountTotal !== undefined) {
      $set.maxTicketsCountTotal = dto.maxTicketsCountTotal;
    }
    if (dto.applyToAllEvents !== undefined) {
      $set.applyToAllEvents = dto.applyToAllEvents;
      if (dto.applyToAllEvents) {
        $set.applicableEventIds = [];
      }
    }
    if (dto.applicableEventIds !== undefined) {
      $set.applicableEventIds = dto.applicableEventIds;
      if (dto.applicableEventIds.length > 0 && dto.applyToAllEvents !== true) {
        $set.applyToAllEvents = false;
      }
    }
    if (Object.keys($set).length === 0) {
      return toResponse(existing);
    }

    try {
      await this.promoCodeModel
        .updateOne({ _id: id, userId: ownerId }, { $set })
        .exec();
    } catch (e: unknown) {
      const err = e as { code?: number };
      if (err.code === 11000) {
        throw new ConflictException('Promo code with this code already exists');
      }
      throw e;
    }

    const updated = await this.promoCodeModel
      .findOne({ _id: id, userId: ownerId })
      .exec();
    if (!updated) {
      throw new NotFoundException('Promo code not found');
    }
    return toResponse(updated);
  }

  async remove(id: string, userId: string): Promise<void> {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Promo code not found');
    }
    const ownerId = Number(userId);
    const existing = await this.promoCodeModel
      .findOne({ _id: id, userId: ownerId })
      .exec();
    if (!existing) {
      throw new NotFoundException('Promo code not found');
    }
    const raw = existing.toObject() as unknown as Record<string, unknown>;
    if (readCurrentTicketsCountTotal(raw) > 0) {
      throw new BadRequestException(
        'Cannot delete a promo code after it has been used for ticket purchases',
      );
    }
    await this.promoCodeModel.deleteOne({ _id: id, userId: ownerId }).exec();
  }

  /**
   * After a paid order, record tickets bought with this promo for the customer.
   */
  async incrementCustomerPromoUsage(
    customerId: number,
    promoCodeId: string,
    ticketCount: number,
  ): Promise<void> {
    if (!mongoose.Types.ObjectId.isValid(promoCodeId) || ticketCount < 1) {
      return;
    }
    const oid = new mongoose.Types.ObjectId(promoCodeId);
    await this.customerPromoUsageModel
      .findOneAndUpdate(
        { customerId, promoCodeId: oid },
        { $inc: { ticketsPurchased: ticketCount } },
        { upsert: true, new: true },
      )
      .exec();
    await this.promoCodeModel
      .updateOne(
        { _id: oid },
        { $inc: { currentTicketsCountTotal: ticketCount } },
      )
      .exec();
  }

  /**
   * Admin vault only (silent ticket removal): takes tickets back off the promo usage
   * counters — the reverse of incrementCustomerPromoUsage, never below zero.
   */
  async decrementCustomerPromoUsage(
    customerId: number,
    promoCodeId: string,
    ticketCount: number,
  ): Promise<void> {
    if (!mongoose.Types.ObjectId.isValid(promoCodeId) || ticketCount < 1) {
      return;
    }
    const oid = new mongoose.Types.ObjectId(promoCodeId);
    // Pipeline updates: the counter is clamped at 0 in the same atomic write.
    await this.customerPromoUsageModel
      .updateOne({ customerId, promoCodeId: oid }, [
        {
          $set: {
            ticketsPurchased: {
              $max: [0, { $subtract: ['$ticketsPurchased', ticketCount] }],
            },
          },
        },
      ])
      .exec();
    await this.promoCodeModel
      .updateOne({ _id: oid }, [
        {
          $set: {
            currentTicketsCountTotal: {
              $max: [0, { $subtract: ['$currentTicketsCountTotal', ticketCount] }],
            },
          },
        },
      ])
      .exec();
  }

  /**
   * Read-only check for checkout UI: code exists, not expired, applies to event,
   * global ticket pool and per-customer limits (using `customerId` from auth).
   */
  async checkPromoCodeForTicket(
    dto: CheckPromoCodeForTicketDto,
    customerId: number,
  ): Promise<PromoCodeTicketCheckResponseDto> {
    const trimmed = dto.code.trim();
    if (!trimmed) {
      throw new NotFoundException({
        code: PROMO_CODE_TICKET_CHECK_ERROR.NOT_FOUND,
        message: 'Promo code not found.',
      });
    }

    const promo = await this.promoCodeModel
      .findOne({
        promoCode: trimmed,
      })
      .exec();

    if (!promo) {
      throw new NotFoundException({
        code: PROMO_CODE_TICKET_CHECK_ERROR.NOT_FOUND,
        message: 'Promo code not found.',
      });
    }

    const event = await this.eventsService.findOneByNumericId(dto.eventId);

    if (event.status !== 'ACTIVE') {
      throw new BadRequestException({
        code: PROMO_CODE_TICKET_CHECK_ERROR.EVENT_NOT_ACTIVE,
        message: 'This event is not available for ticket purchase.',
      });
    }

    const expiresAt = new Date(promo.expirationDate).getTime();
    if (Number.isNaN(expiresAt) || Date.now() > expiresAt) {
      throw new BadRequestException({
        code: PROMO_CODE_TICKET_CHECK_ERROR.EXPIRED,
        message: 'This promo code has expired.',
      });
    }

    if (promo.applyToAllEvents) {
      if (promo.userId !== event.creator) {
        throw new BadRequestException({
          code: PROMO_CODE_TICKET_CHECK_ERROR.NOT_FOR_EVENT,
          message: 'This promo code cannot be used for this event.',
        });
      }
    } else {
      const ids = promo.applicableEventIds ?? [];
      const matches = ids.some(
        (id) => String(id) === String(dto.eventId) || Number(id) === dto.eventId,
      );
      if (!matches) {
        throw new BadRequestException({
          code: PROMO_CODE_TICKET_CHECK_ERROR.NOT_FOR_EVENT,
          message: 'This promo code cannot be used for this event.',
        });
      }
    }

    const promoRaw = promo.toObject ? promo.toObject() : promo;
    const promoRecord = promoRaw as unknown as Record<string, unknown>;
    const maxByCustomer = readMaxTicketsCountByCustomer(promoRecord);
    const maxTotal = readMaxTicketsCountTotal(promoRecord);
    const currentTotal = readCurrentTicketsCountTotal(promoRecord);
    const remainingTotal = maxTotal - currentTotal;

    if (remainingTotal <= 0) {
      throw new BadRequestException({
        code: PROMO_CODE_TICKET_CHECK_ERROR.TICKET_LIMIT_REACHED,
        message: 'This promo code has reached its global ticket limit.',
      });
    }

    if (
      dto.ticketCount !== undefined &&
      dto.ticketCount > remainingTotal
    ) {
      throw new BadRequestException({
        code: PROMO_CODE_TICKET_CHECK_ERROR.TICKET_COUNT_EXCEEDS_REMAINING,
        message: `This promo code can only be used for ${remainingTotal} more ticket(s) in total.`,
      });
    }

    let customerTicketsPurchased = 0;
    let remainingByCustomer = maxByCustomer;
    const usage = await this.customerPromoUsageModel
      .findOne({
        customerId,
        promoCodeId: promo._id,
      })
      .exec();
    customerTicketsPurchased = usage?.ticketsPurchased ?? 0;
    remainingByCustomer = maxByCustomer - customerTicketsPurchased;

    if (remainingByCustomer <= 0) {
      throw new BadRequestException({
        code: PROMO_CODE_TICKET_CHECK_ERROR.TICKET_LIMIT_REACHED,
        message: 'You have reached your ticket limit for this promo code.',
      });
    }

    if (
      dto.ticketCount !== undefined &&
      dto.ticketCount > remainingByCustomer
    ) {
      throw new BadRequestException({
        code: PROMO_CODE_TICKET_CHECK_ERROR.TICKET_COUNT_EXCEEDS_REMAINING,
        message: `This promo code can only be used for ${remainingByCustomer} more ticket(s) for your account.`,
      });
    }

    const remainingTickets = Math.min(remainingByCustomer, remainingTotal);

    return {
      promoCode: promo.promoCode,
      discountType: promo.discountType,
      discountValue: promo.discountValue,
      expirationDate: new Date(promo.expirationDate).toISOString(),
      maxTicketsCountByCustomer: maxByCustomer,
      maxTicketsCountTotal: maxTotal,
      currentTicketsCountTotal: currentTotal,
      customerTicketsPurchased,
      remainingTickets,
      eventId: dto.eventId,
      promoCodeId: (promo._id as mongoose.Types.ObjectId).toString(),
    };
  }
}
