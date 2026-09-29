import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import mongoose from 'mongoose';
import { IEvent, EventSchema } from '../events/schemas/event.schema';
import { EventsService } from '../events/events.service';
import { CreateManagerDto } from './dto/create-manager.dto';
import { UpdateManagerDto } from './dto/update-manager.dto';
import { MANAGER_TYPES, ManagerType } from './manager-type';
import { IManager, ManagerSchema } from './schemas/manager.schema';
import { venueLabel } from '../events/utils/venue.util';

@Injectable()
export class ManagersService {
  constructor(
    @Inject(forwardRef(() => EventsService))
    private readonly eventsService: EventsService,
  ) {}

  private get managerModel(): mongoose.Model<IManager> {
    return (mongoose.models.Manager as mongoose.Model<IManager>) ?? mongoose.model<IManager>('Manager', ManagerSchema);
  }

  private get eventModel(): mongoose.Model<IEvent> {
    return (mongoose.models.Event as mongoose.Model<IEvent>) ?? mongoose.model<IEvent>('Event', EventSchema);
  }

  private normalizeEmail(email?: string): string {
    return (email ?? '').trim().toLowerCase();
  }

  private normalizeCashierName(name?: string): string {
    return (name ?? '').trim();
  }

  private ensureTypeAllowed(type: string): void {
    if (!MANAGER_TYPES.includes(type as ManagerType)) {
      throw new BadRequestException(`type must be one of: ${MANAGER_TYPES.join(', ')}`);
    }
  }

  private normalizeEventIds(events?: number[], event?: number): number[] {
    const source: number[] = [];
    if (Array.isArray(events)) {
      source.push(...events);
    }
    if (event !== undefined && event !== null) {
      source.push(event);
    }
    if (!source.length) return [];
    const normalized = source
      .map((eventId) => Number(eventId))
      .filter((eventId) => Number.isInteger(eventId) && eventId > 0);
    return Array.from(new Set(normalized));
  }

  private getManagerEventIds(manager: Partial<IManager> & { event?: unknown }): number[] {
    if (manager.allEvents) {
      return [];
    }
    const fromEvents = this.normalizeEventIds(manager.events);
    if (fromEvents.length) {
      return fromEvents;
    }
    const legacyEvent = Number((manager as { event?: unknown }).event);
    return Number.isInteger(legacyEvent) && legacyEvent > 0 ? [legacyEvent] : [];
  }

  private async getOrganizerEventIds(organizerId: number): Promise<number[]> {
    if (!Number.isInteger(organizerId) || organizerId <= 0) {
      return [];
    }
    const rawEventIds = await this.eventModel.distinct('id', { creator: organizerId }).exec();
    return Array.from(
      new Set(rawEventIds.filter((id): id is number => Number.isInteger(id) && id > 0)),
    );
  }

  private async resolveManagerEventIds(manager: Partial<IManager> & { event?: unknown }): Promise<number[]> {
    if (manager.allEvents) {
      const organizerId = Number(manager.createdByUserId);
      return this.getOrganizerEventIds(organizerId);
    }
    return this.getManagerEventIds(manager);
  }

  /** Event must exist and belong to this organizer (same rules as EventsService.findOne). */
  private async assertOrganizerEventExists(eventId: number, organizerId: string): Promise<void> {
    const id = Number(eventId);
    if (!Number.isInteger(id) || id < 1) {
      throw new BadRequestException('Invalid event id');
    }
    await this.eventsService.findOne(String(id), organizerId);
  }

  /** One manager row per email globally. */
  private async assertManagerEmailNotInUse(normalizedEmail: string): Promise<void> {
    if (!normalizedEmail) return;
    const existing = await this.managerModel.findOne({ email: normalizedEmail }).lean().exec();
    if (existing) {
      throw new ConflictException('Manager with this email already exists');
    }
  }

  private async assertCashierPinNotInUse(pin: string, excludeId?: number): Promise<void> {
    const normalizedPin = (pin ?? '').trim();
    if (!normalizedPin) return;
    const query: Record<string, unknown> = { type: 'Cashier', cashierPin: normalizedPin };
    if (excludeId !== undefined) query.id = { $ne: excludeId };
    const existing = await this.managerModel.findOne(query).lean().exec();
    if (existing) {
      throw new ConflictException('Cashier with this PIN already exists');
    }
  }

  private buildInternalCashierEmail(): string {
    return `cashier_${Date.now()}_${randomUUID().slice(0, 8)}@cashier.local`;
  }

  async create(dto: CreateManagerDto, organizerId: string): Promise<IManager> {
    this.ensureTypeAllowed(dto.type);

    const normalizedEmail = this.normalizeEmail(dto.email);
    const cashierName = this.normalizeCashierName(dto.cashierName);
    const orgId = Number(organizerId);
    if (Number.isNaN(orgId)) {
      throw new BadRequestException('Invalid organizer id');
    }

    const allEvents = dto.allEvents === true;
    const eventIds = allEvents ? [] : this.normalizeEventIds(dto.events, dto.event);
    if (!allEvents) {
      for (const eventId of eventIds) {
        await this.assertOrganizerEventExists(eventId, organizerId);
      }
    }
    if (dto.type === 'Cashier') {
      if (!cashierName) {
        throw new BadRequestException('cashierName is required for cashier');
      }
      if (!dto.cashierPin?.trim()) {
        throw new BadRequestException('cashierPin is required for cashier');
      }
      await this.assertCashierPinNotInUse(dto.cashierPin.trim());
    } else {
      if (!normalizedEmail) {
        throw new BadRequestException('email is required');
      }
      await this.assertManagerEmailNotInUse(normalizedEmail);
    }

    const cashierPin = dto.type === 'Cashier' ? dto.cashierPin!.trim() : '';

    const internalCashierEmail = dto.type === 'Cashier' ? this.buildInternalCashierEmail() : normalizedEmail;

    const manager = new this.managerModel({
      title: dto.title.trim(),
      type: dto.type.trim(),
      allEvents,
      ...(eventIds.length ? { events: eventIds } : {}),
      ...(eventIds.length ? { event: eventIds[0] } : {}),
      email: internalCashierEmail,
      cashierName: dto.type === 'Cashier' ? cashierName : '',
      cashierPin,
      description: dto.description?.trim() ?? '',
      createdByUserId: orgId,
    });
    return manager.save();
  }

  async findAllForOrganizer(organizerId: string): Promise<IManager[]> {
    const createdByUserId = Number(organizerId);
    if (Number.isNaN(createdByUserId)) {
      return [];
    }
    return this.managerModel
      .find({ createdByUserId })
      .sort({ createdAt: -1 })
      .lean()
      .exec() as Promise<IManager[]>;
  }

  async findByEmailAndEvent(email: string, event: number): Promise<IManager | null> {
    const normalized = this.normalizeEmail(email);
    if (!normalized) return null;
    return this.managerModel
      .findOne({ email: normalized, $or: [{ events: event }, { event }] })
      .lean()
      .exec() as Promise<IManager | null>;
  }

  /** All manager rows for this email (same person may manage multiple events). */
  async findManagersByEmail(email: string): Promise<IManager[]> {
    const normalized = this.normalizeEmail(email);
    if (!normalized) return [];
    return this.managerModel
      .find({ email: normalized })
      .sort({ id: 1 })
      .lean()
      .exec() as Promise<IManager[]>;
  }

  /** Exactly one manager row for this email, or null if none. */
  async findOneByEmail(email: string): Promise<IManager | null> {
    const managers = await this.findManagersByEmail(email);
    if (managers.length === 0) {
      return null;
    }
    if (managers.length > 1) {
      throw new BadRequestException('multiple_manager_accounts');
    }
    return managers[0];
  }

  async findCashierByPin(pin: string): Promise<IManager | null> {
    const normalizedPin = (pin ?? '').trim();
    if (!normalizedPin) return null;
    const manager = await this.managerModel
      .findOne({ type: 'Cashier', cashierPin: normalizedPin })
      .lean()
      .exec() as IManager | null;
    return manager;
  }

  async findActiveEventsForAssignedEventIds(
    eventIds: number[],
  ): Promise<Array<{ id: number; title: string; status: 'ACTIVE' }>> {
    const unique = Array.from(
      new Set(eventIds.filter((id): id is number => Number.isInteger(id) && id > 0)),
    );
    if (!unique.length) {
      return [];
    }
    const events = await this.eventModel
      .find({ id: { $in: unique }, status: 'ACTIVE' })
      .select({ id: 1, title: 1, status: 1 })
      .sort({ createdAt: -1 })
      .lean()
      .exec();

    return (events as IEvent[]).map((event) => ({
      id: event.id,
      title: event.title?.ru?.trim() || event.title?.en?.trim() || event.title?.th?.trim() || `Event #${event.id}`,
      status: 'ACTIVE' as const,
    }));
  }

  async findActiveEventsForManagerEmail(email: string): Promise<Array<{ id: number; title: string; status: 'ACTIVE' }>> {
    const normalizedEmail = this.normalizeEmail(email);
    const allEventsManager = await this.managerModel
      .findOne({ email: normalizedEmail, allEvents: true })
      .lean()
      .exec();
    if (allEventsManager) {
      const organizerId = Number(allEventsManager.createdByUserId);
      if (Number.isInteger(organizerId) && organizerId > 0) {
        const eventIds = await this.getOrganizerEventIds(organizerId);
        return this.findActiveEventsForAssignedEventIds(eventIds);
      }
    }
    const [rawEventIds, legacyRawEventIds] = await Promise.all([
      this.managerModel.distinct('events', { email: normalizedEmail }).exec(),
      this.managerModel.distinct('event', { email: normalizedEmail }).exec(),
    ]);
    const eventIds = Array.from(
      new Set(
        [...rawEventIds, ...legacyRawEventIds].filter((id): id is number => typeof id === 'number' && !Number.isNaN(id)),
      ),
    );
    return this.findActiveEventsForAssignedEventIds(eventIds);
  }

  async findById(id: string): Promise<IManager | null> {
    const n = parseInt(id, 10);
    if (Number.isNaN(n)) return null;
    return this.managerModel.findOne({ id: n }).lean().exec() as Promise<IManager | null>;
  }

  async getAssignedEventIds(managerId: string): Promise<number[]> {
    const manager = await this.findById(managerId);
    if (!manager) {
      throw new NotFoundException('Manager not found');
    }
    return this.resolveManagerEventIds(
      manager as Partial<IManager> & { event?: unknown },
    );
  }

  async assertManagerAssignedToEvent(managerId: string, eventId: number): Promise<void> {
    const manager = await this.findById(managerId);
    if (!manager) {
      throw new NotFoundException('Manager not found');
    }
    if (manager.type !== 'Marketing') {
      return;
    }
    const assignedEventIds = await this.resolveManagerEventIds(
      manager as Partial<IManager> & { event?: unknown },
    );
    if (!assignedEventIds.includes(eventId)) {
      throw new ForbiddenException('Manager is not assigned to this event');
    }
  }

  /**
   * @param eventId Selected event, or `undefined` to default to the first assigned event, or `null` to omit event details (e.g. cashier with multiple events at PIN login).
   */
  async getMe(id: string, eventId?: number | null): Promise<IManager> {
    const manager = await this.findById(id);
    if (!manager) {
      throw new NotFoundException('Manager not found');
    }
    const assignedEventIds = await this.resolveManagerEventIds(
      manager as Partial<IManager> & { event?: unknown },
    );
    let eventNumericId: number | undefined;
    if (eventId === null) {
      eventNumericId = undefined;
    } else if (eventId !== undefined) {
      eventNumericId = assignedEventIds.includes(eventId) ? eventId : undefined;
      if (eventNumericId === undefined) {
        throw new ForbiddenException('Manager is not assigned to this event');
      }
    } else {
      eventNumericId = assignedEventIds[0];
    }
    const event =
      eventNumericId !== undefined
        ? await this.eventModel
            .findOne({ id: eventNumericId })
            .select({ id: 1, title: 1, eventDate: 1, venue: 1 })
            .lean()
            .exec()
        : null;

    return {
      ...(manager as any),
      eventInfo: {
        id: event?.id ?? eventNumericId ?? null,
        title: event?.title ?? { th: '', en: '', ru: '' },
        date: event?.eventDate ?? null,
        location: venueLabel(event?.venue),
      },
    } as IManager;
  }

  async update(id: string, dto: UpdateManagerDto, organizerId: string): Promise<IManager> {
    const n = parseInt(id, 10);
    if (Number.isNaN(n)) {
      throw new NotFoundException('Manager not found');
    }
    this.ensureTypeAllowed(dto.type);

    const existing = await this.managerModel.findOne({ id: n }).exec();
    if (!existing) {
      throw new NotFoundException('Manager not found');
    }
    if (existing.createdByUserId !== Number(organizerId)) {
      throw new ForbiddenException('You can only update your own managers');
    }

    const existingAllEvents = existing.allEvents === true;
    const allEvents = dto.allEvents !== undefined ? dto.allEvents === true : existingAllEvents;
    const nextEvents =
      dto.events !== undefined || dto.event !== undefined || dto.allEvents !== undefined
        ? allEvents
          ? []
          : this.normalizeEventIds(dto.events, dto.event)
        : await this.resolveManagerEventIds(
            existing as Partial<IManager> & { event?: unknown },
          );
    if (!allEvents) {
      for (const eventId of nextEvents) {
        await this.assertOrganizerEventExists(eventId, organizerId);
      }
    }

    const normalizedEmail = this.normalizeEmail(dto.email);
    const cashierName = this.normalizeCashierName(dto.cashierName);
    const isCashier = dto.type === 'Cashier';
    if (isCashier) {
      if (!cashierName) {
        throw new BadRequestException('cashierName is required for cashier');
      }
      if (!dto.cashierPin?.trim()) {
        throw new BadRequestException('cashierPin is required for cashier');
      }
      await this.assertCashierPinNotInUse(dto.cashierPin.trim(), n);
    } else {
      if (!normalizedEmail) {
        throw new BadRequestException('email is required');
      }
      const duplicate = await this.managerModel
        .findOne({ email: normalizedEmail, id: { $ne: n } })
        .lean()
        .exec();
      if (duplicate) {
        throw new ConflictException('Manager with this email already exists');
      }
    }

    const setPayload: Record<string, unknown> = {
      title: dto.title.trim(),
      type: dto.type.trim(),
      allEvents,
      email: isCashier ? (existing.email?.trim() || this.buildInternalCashierEmail()) : normalizedEmail,
      cashierName: isCashier ? cashierName : '',
      description: dto.description?.trim() ?? '',
      events: nextEvents,
      event: nextEvents[0] ?? undefined,
    };
    if (isCashier) {
      setPayload.cashierPin = dto.cashierPin!.trim();
    } else {
      setPayload.cashierPin = '';
    }

    const updated = await this.managerModel
      .findOneAndUpdate({ id: n }, { $set: setPayload }, { new: true })
      .lean()
      .exec();
    if (!updated) {
      throw new NotFoundException('Manager not found');
    }
    return updated as IManager;
  }

  async remove(id: string, organizerId: string): Promise<void> {
    const n = parseInt(id, 10);
    if (Number.isNaN(n)) {
      throw new NotFoundException('Manager not found');
    }
    const existing = await this.managerModel.findOne({ id: n }).exec();
    if (!existing) {
      throw new NotFoundException('Manager not found');
    }
    if (existing.createdByUserId !== Number(organizerId)) {
      throw new ForbiddenException('You can only delete your own managers');
    }
    const existingEvents = await this.resolveManagerEventIds(
      existing as Partial<IManager> & { event?: unknown },
    );
    for (const eventId of existingEvents) {
      await this.assertOrganizerEventExists(eventId, organizerId);
    }
    await this.managerModel.findOneAndDelete({ id: n }).exec();
  }
}
