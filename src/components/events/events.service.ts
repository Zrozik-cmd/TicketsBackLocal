import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import mongoose from 'mongoose';
import {
  EVENT_CITIES,
  EventSchema,
  IEvent,
  ILocalizedText,
  IRecurrence,
  ISector,
  IZone,
} from './schemas/event.schema';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { EventApprovalSnapshotsService } from './event-approval-snapshots.service';
import { EVENT_STATUSES } from './constants/event-status.constant';
import { VISIBLE_ON_SITE_FILTER } from './constants/event-visibility.constant';
import { EVENT_PRIVATE_FIELDS } from './constants/event-private-fields.constant';
import { IMockOrder, MockOrderSchema } from '../mock-orders/schemas/mock-order.schema';
import { ITicket, TicketSchema } from '../tickets/schemas/ticket.schema';
import type { EventTicketSalesStatistics } from '../tickets/dto/event-ticket-sales.dto';
import { MediaService } from '../media/media.service';
import { UsersService } from '../users/users.service';
import { AuthService } from '../users/auth.service';
import type { EventPaymentOptionsDto } from './dto/shared.dto';
import {
  DEFAULT_VAT_PERCENT,
  DEFAULT_PROCESSING_FEE_PERCENT,
  DEFAULT_PLATFORM_FEE_PERCENT,
  DEFAULT_ADDITIONAL_TICKET_COST_FEE_PERCENT,
} from './constants/event-fee-defaults.constant';
import { SupportMessagesService } from '../support-messages/support-messages.service';
import {
  EventSessionsService,
  type SessionSalesSummary,
  type SessionStatusSummary,
  type SessionWithAvailability,
} from '../event-sessions/event-sessions.service';
import { SessionCancellationNotifier } from '../event-sessions/session-cancellation-notifier.service';
import type {
  EventSessionStatus,
  OrganizerSessionStatus,
} from '../event-sessions/schemas/event-session.schema';
import { ReviewsService } from '../reviews/reviews.service';
import { EventMessengersNotifierService } from '../event-messengers/services/event-messengers-notifier.service';
import { SALES_REASON } from '../event-messengers/constants/event-messengers.constants';
import { IndexNowService } from '../../services/indexnow/indexnow.service';
import { isEventSalesEnded, isSessionSalesClosed } from './utils/sales-cutoff.util';
import { isEventOver } from './utils/event-end.util';
import { featuredHomeHeroEventId } from '../home-hero/home-hero-links';
import {
  isEmptyPeriodScope,
  normalizeSessionPeriodFilter,
  periodLinesQuery,
  periodShareExpr,
  periodTicketQuery,
  type SessionPeriodFilter,
} from './utils/session-period-filter.util';

type IEventPlain = Omit<IEvent, keyof mongoose.Document>;

type ZoneTicketCounters = {
  reserved: number;
  bought: number;
};

/** `top` = one-off events, `regular` = events with an enabled recurrence. */
export const PUBLIC_EVENT_KINDS = ['top', 'regular'] as const;
export type PublicEventKind = (typeof PUBLIC_EVENT_KINDS)[number];

type FindPublicOptions = {
  limit?: string;
  offset?: string;
  kind?: string;
};

/**
 * Plain event with per-zone `remaining_tickets` and event-level `soldOut`.
 * Used for public list and public-by-slug responses.
 */
export type PublicEventListItem = IEventPlain & {
  soldOut: boolean;
  /**
   * One-off event whose `salesCloseBefore` cut-off has been reached: the Buy button is
   * off even with seats left. Always `false` for a regular event — the sessions feed
   * carries a per-session `salesClosed` instead.
   */
  salesEnded: boolean;
  /** Aggregate over approved reviews; omitted while the event has none. */
  ratingAvg?: number;
  ratingCount?: number;
};

export interface OwnerZoneStatistics {
  name: ILocalizedText;
  price: number;
  sold: number;
  remaining: number;
  allCount: number;
}

/**
 * Sales for one show of a regular event. A regular event re-sells its zone capacity on
 * every session, so a single event-wide "sold / remaining" pair says nothing useful —
 * the organizer needs the split per day.
 */
export interface OwnerSessionStatistics {
  sessionId: number;
  /** `YYYY-MM-DD`, local Thailand time. */
  date: string;
  start: string;
  end: string;
  status: EventSessionStatus;
  /** Seats offered for this one show (sum of zone seats). */
  capacity: number;
  /** Issued tickets for this show. */
  sold: number;
  /** Held by unpaid orders that have not expired. */
  reserved: number;
  /**
   * `capacity - sold - reserved`, floored at zero; `0` for every non-`active` show and for
   * an `active` one past its sales cut-off (started or played).
   */
  remaining: number;
  /** `sold / capacity * 100`, `0` when the show has no seats configured. */
  fillingPercentage: number;
  /** Revenue from paid orders that include this show. */
  revenue: number;
  /**
   * A `disabled` show the organizer may reopen right now: `status: 'active'` through
   * bulk-status / PATCH would be accepted (flagless, slot in the current schedule, not in
   * the past — `EventSessionsService.isReopenableDisabledSession`). Only a legacy row can
   * qualify (the schedule sync disabled it before `disabledBySchedule` existed), and those
   * are flagged at boot by `EventSessionsService.healLegacyDisabledSessions`, so on healed
   * data this is `false`. Always `false` for any other status; a `sold_out` show reopens
   * through the plain quota toggle. Cancelling a `disabled` show needs no flag: every one
   * not yet over may be cancelled.
   */
  reopenable: boolean;
}

export type OwnerEventStatistics = {
  id: number;
  /** Event title (localized). */
  name: ILocalizedText;
  /** Sum of `seats` across every zone (total inventory for the event). */
  totalTicketsAllZones: number;
  /** Issued ticket documents for this event (one per seat sold). */
  ticketsBought: number;
  /** Seats still purchasable: per zone, `seats - reserved - bought`, summed. */
  ticketsRemainingToBuy: number;
  /** Sum of `total_price` on mock orders with status `paid` for this event. */
  profitFromBoughtTickets: number;
  /** Filling percentage of the event. */
  fillingPercentage: number;
  /** Tickets validated / used at entry (`status === USED`). */
  ticketsUsedSuccessfully: number;
    /** Per-zone sales and capacity, sorted by `ticketsSold / ticketsTotal` descending. */
  zoneStatistics: OwnerZoneStatistics[];
  /**
   * Per-show breakdown, chronological. Empty for one-off events, which have exactly
   * one performance and are fully described by the totals above.
   */
  sessionStatistics: OwnerSessionStatistics[];
  /** Organizer's "hide from site" switch (`PATCH /events/:id/visibility`). */
  hiddenFromSite: boolean;
  /** Organizer archive flag (`POST /events/:id/remove` on an event with sales). */
  archivedByOrganizer: boolean;
};

/** Response of `PATCH /events/:id/visibility`. */
export type EventVisibilityResult = {
  id: number;
  hiddenFromSite: boolean;
  status: IEvent['status'];
};

/** Response of `PATCH /events/:id/cash-payment`. */
export type EventCashPaymentResult = { id: number; cashEnabled: boolean };

@Injectable()
export class EventsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(EventsService.name);

  /**
   * Разовый идемпотентный бэкфилл гео-раздела: до появления поля город можно
   * было узнать только по провинции (Пхукет и Бангкок — свои провинции, Паттайя живёт в Чонбури).
   * События без узнаваемой провинции остаются без city и в гео-афиши не входят.
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      const phuket = await this.eventModel
        .updateMany(
          { city: { $exists: false }, 'province.id': 'phuket' },
          { $set: { city: 'phuket' } },
        )
        .exec();
      const pattaya = await this.eventModel
        .updateMany(
          { city: { $exists: false }, 'province.id': { $in: ['chon-buri', 'pattaya'] } },
          { $set: { city: 'pattaya' } },
        )
        .exec();
      const bangkok = await this.eventModel
        .updateMany(
          { city: { $exists: false }, 'province.id': 'bangkok' },
          { $set: { city: 'bangkok' } },
        )
        .exec();
      if (phuket.modifiedCount || pattaya.modifiedCount || bangkok.modifiedCount) {
        this.logger.log(
          `Event city backfill: phuket=${phuket.modifiedCount}, pattaya=${pattaya.modifiedCount}, bangkok=${bangkok.modifiedCount}`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Event city backfill failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // Approval baselines only now: Nest runs this module's bootstrap hooks concurrently, and a
    // baseline read before the city backfill landed would show `city` as changed until the next
    // approval. Built from the event as the admin detail diffs it (`ensureEventMediaIds`).
    try {
      await mongoose.connection.asPromise();
      const { scanned, created, failed } = await this.approvalSnapshots.backfillBaselines(
        (event) => this.ensureEventMediaIds(event as IEvent),
      );
      if (created || failed) {
        this.logger.log(
          `Event approval baselines: scanned=${scanned}, created=${created}, failed=${failed}`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Event approval baselines failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  constructor(
    private readonly mediaService: MediaService,
    private readonly usersService: UsersService,
    private readonly authService: AuthService,
    private readonly supportMessagesService: SupportMessagesService,
    private readonly eventSessionsService: EventSessionsService,
    private readonly sessionCancellationNotifier: SessionCancellationNotifier,
    private readonly reviewsService: ReviewsService,
    private readonly indexNowService: IndexNowService,
    private readonly approvalSnapshots: EventApprovalSnapshotsService,
    private readonly messengersNotifier: EventMessengersNotifierService,
  ) {}

  /** True when the event runs on a repeating schedule instead of a single date. */
  private isRecurring(event: Pick<IEvent, 'recurrence'>): boolean {
    return event.recurrence?.enabled === true;
  }

  /**
   * Seats still on sale per zone of each regular event in `events`.
   *
   * A one-off event sells its `zone.seats` once, so its event-level counters stay
   * `seats − reserved − bought`. A regular event sells them once per session, so its
   * list cards and `soldOut` read the sum over the sessions still on sale (see
   * EventSessionsService.getOnSaleZoneRemaining); one-off events are not in this map.
   */
  private async onSaleRemainingFor(
    events: Array<Pick<IEvent, 'id' | 'recurrence' | 'salesCloseBefore' | 'sectors'>>,
  ): Promise<Map<number, Map<string, number>>> {
    const recurring = events.filter((event) => this.isRecurring(event));
    if (!recurring.length) return new Map();
    return this.eventSessionsService.getOnSaleZoneRemaining(recurring);
  }

  /** A regular event's per-zone seats on sale (empty when none is), `undefined` for a one-off. */
  private sessionRemainingOf(
    event: Pick<IEvent, 'id' | 'recurrence'>,
    onSaleRemaining: Map<number, Map<string, number>>,
  ): Map<string, number> | undefined {
    return this.isRecurring(event) ? (onSaleRemaining.get(event.id) ?? new Map()) : undefined;
  }

  /** The events whose availability comes from the event-wide ticket counters: one-offs. */
  private oneOffEventIds(events: Array<Pick<IEvent, 'id' | 'recurrence'>>): number[] {
    return events.filter((event) => !this.isRecurring(event)).map((event) => event.id);
  }

  /**
   * Rejects an unbuildable schedule BEFORE anything is written. `syncSessions`
   * runs after the event is persisted, so a schedule error surfacing there left
   * the event (or the update) committed while the client saw a 400 and retried
   * into duplicates. Same generator, same messages — just evaluated up front.
   */
  private assertRecurrenceBuildable(recurrence: IRecurrence | undefined): void {
    if (recurrence?.enabled !== true) return;
    this.eventSessionsService.generateSessionSlots(recurrence);
  }

  /**
   * Regenerates the materialised sessions after an event was saved. The schedule
   * itself is validated up front by `assertRecurrenceBuildable`, so a failure here
   * is an infrastructure hiccup: log it and surface it, the event row is valid.
   */
  private async syncSessions(event: Pick<IEvent, 'id' | 'recurrence'>): Promise<void> {
    try {
      await this.eventSessionsService.syncSessionsForEvent(event.id, event.recurrence);
    } catch (error) {
      this.logger.error(
        `Failed to sync sessions for event ${event.id}: ${(error as Error)?.message}`,
      );
      throw error;
    }
  }

  private get eventModel(): mongoose.Model<IEvent> {
    return (mongoose.models.Event as mongoose.Model<IEvent>) ?? mongoose.model<IEvent>('Event', EventSchema);
  }

  private get mockOrderModel(): mongoose.Model<IMockOrder> {
    return (mongoose.models.MockOrder as mongoose.Model<IMockOrder>) ??
      mongoose.model<IMockOrder>('MockOrder', MockOrderSchema);
  }

  private get ticketModel(): mongoose.Model<ITicket> {
    return (mongoose.models.Ticket as mongoose.Model<ITicket>) ??
      mongoose.model<ITicket>('Ticket', TicketSchema);
  }

  private zoneKey(sectorId: string, zoneId: string): string {
    return `${sectorId}::${zoneId}`;
  }

  private collectZonePairs(
    sectors: Array<Pick<ISector, 'id' | 'zones'>> | undefined,
  ): Array<{ sectorId: string; zoneId: string }> {
    if (!sectors?.length) return [];
    const pairs: Array<{ sectorId: string; zoneId: string }> = [];
    for (const sector of sectors) {
      for (const zone of sector.zones ?? []) {
        pairs.push({ sectorId: sector.id, zoneId: zone.id });
      }
    }
    return pairs;
  }

  private async assertNoPendingOrCompletedMockOrdersOnRemovedZones(
    existingEvent: IEvent,
    nextSectors: Array<Pick<ISector, 'id' | 'zones'>>,
  ): Promise<void> {
    const currentPairs = this.collectZonePairs(existingEvent.sectors ?? []);
    const nextKeys = new Set(
      this.collectZonePairs(nextSectors).map(({ sectorId, zoneId }) => this.zoneKey(sectorId, zoneId)),
    );
    const removedPairs = currentPairs.filter(
      ({ sectorId, zoneId }) => !nextKeys.has(this.zoneKey(sectorId, zoneId)),
    );

    if (!removedPairs.length) return;

    const hasBlockingOrders = await this.mockOrderModel.exists({
      event: existingEvent.id,
      status: { $in: ['wait', 'pending_cash', 'paid'] },
      tickets: {
        $elemMatch: {
          $or: removedPairs.map(({ sectorId, zoneId }) => ({ sectorId, zoneId })),
        },
      },
    });

    if (hasBlockingOrders) {
      throw new BadRequestException(
        'Cannot remove sectors or zones while there are pending or completed mock orders for them.',
      );
    }
  }

  private localizedTextChanged(current?: ILocalizedText, next?: ILocalizedText): boolean {
    return (['th', 'en', 'ru'] as const).some((lang) => {
      const currentValue = current?.[lang]?.trim() ?? '';
      const nextValue = next?.[lang]?.trim() ?? '';
      return currentValue !== nextValue;
    });
  }

  private sectorMapById<T extends Pick<ISector, 'id' | 'zones' | 'name'>>(sectors: T[] | undefined): Map<string, T> {
    return new Map((sectors ?? []).map((sector) => [sector.id, sector]));
  }

  private zoneMapById<T extends Pick<ISector, 'zones'>>(sector: T | undefined): Map<string, NonNullable<T['zones']>[number]> {
    return new Map((sector?.zones ?? []).map((zone) => [zone.id, zone]));
  }

  private async assertSoldTicketStructureEditable(
    existingEvent: IEvent,
    nextSectors: Array<Pick<ISector, 'id' | 'name' | 'zones'>>,
  ): Promise<void> {
    const countersByZone = (await this.buildZoneCountersForEvents([existingEvent.id])).get(existingEvent.id);
    if (!countersByZone) return;

    /*
      "Sold" for the seat-floor check is per show for a regular event: `seats` is
      the capacity of ONE session, so the floor is the busiest session's sales,
      not the whole run's total. The event-wide counters still decide WHICH
      zones/sectors carry sales (and so cannot be renamed or removed).
    */
    const perSessionMax = this.isRecurring(existingEvent)
      ? await this.eventSessionsService.maxBoughtPerSessionByZone(existingEvent.id)
      : null;

    const soldZoneKeys = [...countersByZone.entries()]
      .filter(([, counters]) => counters.bought > 0)
      .map(([key, counters]) => ({
        key,
        sold: perSessionMax ? (perSessionMax.get(key) ?? 0) : counters.bought,
      }));

    if (!soldZoneKeys.length) return;

    const currentSectors = this.sectorMapById(existingEvent.sectors ?? []);
    const nextSectorsById = this.sectorMapById(nextSectors);

    for (const { key, sold } of soldZoneKeys) {
      const [sectorId, zoneId] = key.split('::');
      const currentSector = currentSectors.get(sectorId);
      const nextSector = nextSectorsById.get(sectorId);

      if (!nextSector || (currentSector && this.localizedTextChanged(currentSector.name, nextSector.name))) {
        throw new BadRequestException(
          'Cannot change this sector because tickets have already been issued for it.',
        );
      }

      const currentZone = this.zoneMapById(currentSector).get(zoneId);
      const nextZone = this.zoneMapById(nextSector).get(zoneId);

      if (!nextZone) {
        throw new BadRequestException(
          'Cannot change this zone because tickets have already been issued for it.',
        );
      }

      if (currentZone && this.localizedTextChanged(currentZone.name, nextZone.name)) {
        throw new BadRequestException(
          'Cannot change this ticket because it already has sales.',
        );
      }

      if (Number.isFinite(nextZone.seats) && nextZone.seats < sold) {
        throw new BadRequestException(
          'Cannot reduce ticket limit below already issued tickets for this zone.',
        );
      }
    }
  }

  private isPositiveNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
  }

  /** First non-empty localized title for admin/channel messages. */
  private pickLocalizedTitle(title: ILocalizedText): string {
    const candidates = [title.en, title.th, title.ru].map((s) => (typeof s === 'string' ? s.trim() : ''));
    return candidates.find((s) => s.length > 0) ?? '—';
  }

  private parseMediaId(value: unknown): number | undefined {
    if (this.isPositiveNumber(value)) return value;
    if (typeof value === 'string') {
      const n = Number.parseInt(value, 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return undefined;
  }

  private isLegacyImageObject(value: unknown): value is { url: string; mimeType?: string } {
    if (!value || typeof value !== 'object') return false;
    const v = value as Record<string, unknown>;
    return typeof v.url === 'string' && /^data:[^;]+;base64,/i.test(v.url.trim());
  }

  private isPlanImageResolved(
    event: Record<string, unknown>,
    field: string,
    resolvedId: number | undefined,
  ): boolean {
    return Boolean(resolvedId) || !event[field] || !this.isLegacyImageObject(event[field]);
  }

  private async createMediaIdFromImageData(
    image: { url: string; mimeType?: string },
    userId: number,
  ): Promise<number> {
    return this.mediaService.createFromDataUrl(image.url, userId, image.mimeType);
  }

  /**
   * Turns the submitted gallery list into Media ids, uploading only the entries
   * that carry a data URL. Existing ids are kept only if they belong to this
   * event's current gallery — a client can reorder or drop its own photos, but
   * cannot attach some other event's media by guessing an id. Returns the ids
   * that were in the old gallery but are gone from the new one, so the caller
   * can delete the orphaned files.
   */
  private async resolveGalleryImages(
    entries: Array<{ mediaId?: number; image?: { url: string; mimeType?: string } }>,
    userId: number,
    currentIds: number[],
  ): Promise<{ ids: number[]; removed: number[] }> {
    const allowed = new Set(currentIds);
    const ids: number[] = [];
    for (const entry of entries) {
      if (entry.image?.url && /^data:/i.test(entry.image.url.trim())) {
        ids.push(await this.createMediaIdFromImageData(entry.image, userId));
      } else if (typeof entry.mediaId === 'number' && allowed.has(entry.mediaId)) {
        ids.push(entry.mediaId);
      }
      // Anything else (unknown id, http URL) is silently dropped.
    }
    const keep = new Set(ids);
    return { ids, removed: currentIds.filter((id) => !keep.has(id)) };
  }

  async sendPaymentPhoneCode(phoneNumber: string): Promise<{ ok: boolean }> {
    return this.authService.sendPaymentPhoneCode(phoneNumber);
  }

  async verifyPaymentPhoneCode(phoneNumber: string, code: string): Promise<{ ok: boolean }> {
    const ok = await this.authService.checkPhoneCode(phoneNumber, code);
    if (!ok) {
      throw new BadRequestException('invalid_phone_code');
    }
    return { ok: true };
  }

  private legacyPaymentOptions(): IEventPlain['paymentOptions'] {
    return {
      thb: {
        accountNumber: '',
        recipientName: '',
        phoneNumber: '',
        hasCustomQrCode: false,
        useLegacyQrFallback: true,
      },
      cashEnabled: false,
    };
  }

  private withPaymentOptionsFallback<T extends Record<string, unknown>>(event: T): T {
    const paymentOptions = event.paymentOptions as IEventPlain['paymentOptions'] | undefined;
    if (!paymentOptions?.thb) {
      return {
        ...event,
        paymentOptions: this.legacyPaymentOptions(),
      };
    }

    const qrCodeImage = paymentOptions.thb.qrCodeImage;
    return {
      ...event,
      paymentOptions: {
        ...paymentOptions,
        cashEnabled: paymentOptions.cashEnabled === true,
        thb: {
          ...paymentOptions.thb,
          hasCustomQrCode: this.isPositiveNumber(qrCodeImage),
          useLegacyQrFallback: false,
        },
      },
    };
  }

  private async resolvePaymentOptionsForSave(
    dtoPaymentOptions: EventPaymentOptionsDto,
    creator: number,
    existing?: IEvent,
    requirePhoneCode = true,
  ): Promise<{
    paymentOptions: IEventPlain['paymentOptions'];
    oldQrCodeImageToRemove?: number;
  }> {
    // PromptPay is issued by Omise now, so the organizer form no longer collects manual
    // THB receiver details. Keep whatever an existing event already stored (in-flight
    // legacy receipts still validate against it) and fall back to empty legacy values.
    if (!dtoPaymentOptions.thb) {
      const existingThb = existing?.paymentOptions?.thb;
      return {
        paymentOptions: {
          thb: existingThb
            ? {
                accountNumber: existingThb.accountNumber ?? '',
                recipientName: existingThb.recipientName ?? '',
                phoneNumber: existingThb.phoneNumber ?? '',
                qrCodeImage: existingThb.qrCodeImage,
                hasCustomQrCode: this.isPositiveNumber(existingThb.qrCodeImage),
                useLegacyQrFallback: false,
              }
            : {
                accountNumber: '',
                recipientName: '',
                phoneNumber: '',
                hasCustomQrCode: false,
                useLegacyQrFallback: true,
              },
          cashEnabled: dtoPaymentOptions.cashEnabled === true,
        },
      };
    }

    const nextPhone = dtoPaymentOptions.thb.phoneNumber.trim();
    const existingPhone = existing?.paymentOptions?.thb?.phoneNumber?.trim();
    const phoneUnchanged = Boolean(existingPhone) && existingPhone === nextPhone;
    if (!phoneUnchanged && requirePhoneCode) {
      const phoneCode = dtoPaymentOptions.thb.phoneCode?.trim();
      if (!phoneCode) {
        throw new BadRequestException('payment_phone_code_required');
      }
      const phoneOk = await this.authService.checkPhoneCode(nextPhone, phoneCode);
      if (!phoneOk) {
        throw new BadRequestException('invalid_phone_code');
      }
    }

    const currentQrCodeImage = this.parseMediaId(existing?.paymentOptions?.thb?.qrCodeImage);
    let nextQrCodeImage = currentQrCodeImage;
    let oldQrCodeImageToRemove: number | undefined;
    if (dtoPaymentOptions.thb.qrCodeImage) {
      nextQrCodeImage = await this.createMediaIdFromImageData(dtoPaymentOptions.thb.qrCodeImage, creator);
      if (currentQrCodeImage && currentQrCodeImage !== nextQrCodeImage) {
        oldQrCodeImageToRemove = currentQrCodeImage;
      }
    }

    return {
      paymentOptions: {
        thb: {
          accountNumber: dtoPaymentOptions.thb.accountNumber.trim(),
          recipientName: dtoPaymentOptions.thb.recipientName.trim(),
          phoneNumber: nextPhone,
          qrCodeImage: nextQrCodeImage,
          hasCustomQrCode: this.isPositiveNumber(nextQrCodeImage),
          useLegacyQrFallback: false,
        },
        cashEnabled: dtoPaymentOptions.cashEnabled === true,
      },
      oldQrCodeImageToRemove,
    };
  }

  /** Resolves legacy image payloads to media ids; used by admin event detail and internally. */
  async ensureEventMediaIds(event: IEvent): Promise<IEvent> {
    const e = event as Record<string, unknown> & IEvent;
    const coverId = this.parseMediaId(e.coverImage);
    const seatingId = this.parseMediaId(e.seatingPlanImage);
    const parkingId = this.parseMediaId(e.parkingPlanImage);
    const coverLegacy = this.isLegacyImageObject(e.coverImage) ? e.coverImage : undefined;
    const seatingLegacy = this.isLegacyImageObject(e.seatingPlanImage) ? e.seatingPlanImage : undefined;
    const parkingLegacy = this.isLegacyImageObject(e.parkingPlanImage) ? e.parkingPlanImage : undefined;

    if (
      coverId &&
      this.isPlanImageResolved(e, 'seatingPlanImage', seatingId) &&
      this.isPlanImageResolved(e, 'parkingPlanImage', parkingId)
    ) {
      return {
        ...e,
        coverImage: coverId,
        seatingPlanImage: seatingId,
        parkingPlanImage: parkingId,
        paymentOptions: this.withPaymentOptionsFallback(e).paymentOptions,
      } as IEvent;
    }

    const creatorId = Number(e.creator);
    const nextCoverId =
      coverId ??
      (coverLegacy ? await this.createMediaIdFromImageData(coverLegacy, creatorId) : undefined);
    const nextSeatingId =
      seatingId ??
      (seatingLegacy ? await this.createMediaIdFromImageData(seatingLegacy, creatorId) : undefined);
    const nextParkingId =
      parkingId ??
      (parkingLegacy ? await this.createMediaIdFromImageData(parkingLegacy, creatorId) : undefined);

    if (!nextCoverId) {
      throw new NotFoundException('Event cover image is missing');
    }

    const setPayload: Record<string, unknown> = { coverImage: nextCoverId };
    const unsetPayload: Record<string, 1> = {};

    if (nextSeatingId) {
      setPayload.seatingPlanImage = nextSeatingId;
    } else if (e.seatingPlanImage) {
      unsetPayload.seatingPlanImage = 1;
    }

    if (nextParkingId) {
      setPayload.parkingPlanImage = nextParkingId;
    } else if (e.parkingPlanImage) {
      unsetPayload.parkingPlanImage = 1;
    }

    const updateOp: mongoose.UpdateQuery<IEvent> = { $set: setPayload };
    if (Object.keys(unsetPayload).length) {
      updateOp.$unset = unsetPayload;
    }
    await this.eventModel.updateOne({ id: event.id }, updateOp).exec();

    return {
      ...e,
      coverImage: nextCoverId,
      seatingPlanImage: nextSeatingId,
      parkingPlanImage: nextParkingId,
      paymentOptions: this.withPaymentOptionsFallback(e).paymentOptions,
    } as IEvent;
  }

  private async buildZoneCountersForEvents(eventIds: number[]): Promise<Map<number, Map<string, ZoneTicketCounters>>> {
    const countersByEvent = new Map<number, Map<string, ZoneTicketCounters>>();
    if (!eventIds.length) {
      return countersByEvent;
    }

    const [reservedOrders, boughtTickets] = await Promise.all([
      this.mockOrderModel
        .find({ event: { $in: eventIds }, status: { $in: ['wait', 'pending_cash'] } })
        .select({ event: 1, tickets: 1 })
        .lean()
        .exec(),
      this.ticketModel
        .find({ eventId: { $in: eventIds } })
        .select({ eventId: 1, sector: 1, zone: 1 })
        .lean()
        .exec(),
    ]);

    for (const order of reservedOrders as Array<Pick<IMockOrder, 'event' | 'tickets'>>) {
      let eventCounters = countersByEvent.get(order.event);
      if (!eventCounters) {
        eventCounters = new Map<string, ZoneTicketCounters>();
        countersByEvent.set(order.event, eventCounters);
      }

      for (const item of order.tickets ?? []) {
        const key = this.zoneKey(item.sectorId, item.zoneId);
        const counters = eventCounters.get(key) ?? { reserved: 0, bought: 0 };
        counters.reserved += item.count ?? 0;
        eventCounters.set(key, counters);
      }
    }

    for (const ticket of boughtTickets as Array<Pick<ITicket, 'eventId' | 'sector' | 'zone'>>) {
      let eventCounters = countersByEvent.get(ticket.eventId);
      if (!eventCounters) {
        eventCounters = new Map<string, ZoneTicketCounters>();
        countersByEvent.set(ticket.eventId, eventCounters);
      }
      const key = this.zoneKey(ticket.sector, ticket.zone);
      const counters = eventCounters.get(key) ?? { reserved: 0, bought: 0 };
      counters.bought += 1;
      eventCounters.set(key, counters);
    }

    return countersByEvent;
  }

  /**
   * Remaining purchasable seats (sum over zones of max(0, seats - reserved - bought)).
   * `sessionRemainingByZone` (a regular event's seats on sale, see `onSaleRemainingFor`)
   * replaces that arithmetic when given.
   */
  private remainingPurchasableSeats(
    event: IEvent,
    countersByZone: Map<string, ZoneTicketCounters> | undefined,
    sessionRemainingByZone?: Map<string, number>,
  ): number {
    let sum = 0;
    for (const sector of event.sectors ?? []) {
      for (const zone of sector.zones ?? []) {
        sum += this.zoneRemaining(sector.id, zone, countersByZone, sessionRemainingByZone);
      }
    }
    return sum;
  }

  private zoneRemaining(
    sectorId: string,
    zone: Pick<IZone, 'id' | 'seats'>,
    countersByZone: Map<string, ZoneTicketCounters> | undefined,
    sessionRemainingByZone?: Map<string, number>,
  ): number {
    const key = this.zoneKey(sectorId, zone.id);
    if (sessionRemainingByZone) return sessionRemainingByZone.get(key) ?? 0;
    const counters = countersByZone?.get(key);
    return Math.max((zone.seats ?? 0) - (counters?.reserved ?? 0) - (counters?.bought ?? 0), 0);
  }

  /**
   * Remaining purchasable seats per event (sum over zones of max(0, seats - reserved - bought)).
   */
  async getAvailableTicketsCountByEventIds(eventIds: number[]): Promise<Map<number, number>> {
    const map = new Map<number, number>();
    if (!eventIds.length) {
      return map;
    }
    const events = (await this.eventModel
      .find({ id: { $in: eventIds } })
      .lean()
      .exec()) as IEvent[];
    const countersByEvent = await this.buildZoneCountersForEvents(eventIds);
    for (const event of events) {
      const remaining = this.remainingPurchasableSeats(event, countersByEvent.get(event.id));
      map.set(event.id, remaining);
    }
    return map;
  }

  private applyAvailabilityToEvent(
    event: IEvent,
    countersByZone: Map<string, ZoneTicketCounters> | undefined,
    includeSoldTickets = false,
    sessionRemainingByZone?: Map<string, number>,
  ): IEvent {
    const sectors = (event.sectors ?? []).map((sector) => ({
      ...sector,
      zones: (sector.zones ?? []).map((zone) => {
        const bought = countersByZone?.get(this.zoneKey(sector.id, zone.id))?.bought ?? 0;
        const zoneWithAvailability = {
          ...zone,
          remaining_tickets: this.zoneRemaining(sector.id, zone, countersByZone, sessionRemainingByZone),
        };
        return includeSoldTickets
          ? { ...zoneWithAvailability, sold_tickets: bought }
          : zoneWithAvailability;
      }),
    }));

    return { ...event, sectors } as unknown as IEvent;
  }

  /** Strips organizer/admin-only fields from a public payload (the list and why: EVENT_PRIVATE_FIELDS). */
  private withoutPrivateFields(event: IEvent): IEvent {
    const publicEvent = { ...event } as IEvent;
    for (const field of EVENT_PRIVATE_FIELDS) delete publicEvent[field];
    return publicEvent;
  }

  async create(dto: CreateEventDto, creatorId: string): Promise<IEvent> {
    const creator = Number(creatorId);
    // Fail on a bad schedule before uploading media or inserting the event.
    this.assertRecurrenceBuildable(dto.recurrence as IRecurrence | undefined);
    const coverImage = await this.createMediaIdFromImageData(dto.coverImage, creator);
    const galleryImages = dto.galleryImages?.length
      ? (await this.resolveGalleryImages(dto.galleryImages, creator, [])).ids
      : [];
    const seatingPlanImage = dto.seatingPlanImage
      ? await this.createMediaIdFromImageData(dto.seatingPlanImage, creator)
      : undefined;
    const parkingPlanImage = dto.parkingPlanImage
      ? await this.createMediaIdFromImageData(dto.parkingPlanImage, creator)
      : undefined;
    const { paymentOptions } = await this.resolvePaymentOptionsForSave(
      dto.paymentOptions,
      creator,
      undefined,
      dto.status !== 'DRAFT',
    );
    const creatorUser = await this.usersService.findById(String(creator));
    const vatPercent = creatorUser?.defaultVatPercent ?? DEFAULT_VAT_PERCENT;
    const processingFeePercent =
      creatorUser?.defaultProcessingFeePercent ?? DEFAULT_PROCESSING_FEE_PERCENT;
    const platformFeePercent =
      creatorUser?.defaultPlatformFeePercent ?? DEFAULT_PLATFORM_FEE_PERCENT;
    const additionalTicketCostFeePercent =
      creatorUser?.defaultAdditionalTicketCostFeePercent ??
      DEFAULT_ADDITIONAL_TICKET_COST_FEE_PERCENT;

    const payload: Record<string, unknown> = {
      ...dto,
      creator,
      status: dto.status,
      coverImage,
      ...(galleryImages.length ? { galleryImages } : { galleryImages: undefined }),
      paymentOptions,
      vatPercent,
      additionalTicketCostFeePercent,
      processingFeePercent,
      platformFeePercent,
    };
    if (seatingPlanImage) {
      payload.seatingPlanImage = seatingPlanImage;
    }
    if (parkingPlanImage) {
      payload.parkingPlanImage = parkingPlanImage;
    }
    if (!dto.recurrence?.enabled) {
      // A one-off event must never carry a stale schedule from an earlier draft.
      delete payload.recurrence;
    }
    if (!dto.ticketCopyEmail) {
      // `''` means "no copy": keep the field absent rather than store an empty string.
      delete payload.ticketCopyEmail;
    }
    const event = new this.eventModel(payload);
    const saved = await event.save();
    this.logger.log(`Event created: ${saved._id}`);
    const created = await this.ensureEventMediaIds(saved.toObject() as IEvent);
    await this.syncSessions(created);
    // TEMP: moderation notice to the Telegram support group is disabled — uncomment to restore.
    // if (created.status === 'MODERATION') {
    //   void this.supportMessagesService.notifyEventModerationChannel({
    //     eventId: created.id,
    //     title: this.pickLocalizedTitle(created.title),
    //     kind: 'created',
    //   });
    // }
    // A newly published event has a 3-6 week sales window — push it to
    // IndexNow immediately instead of waiting for a crawl (SEO audit task 22).
    if (created.status === 'ACTIVE') {
      this.indexNowService.notifyPaths([
        this.indexNowService.eventPath(created.id, created.title?.en),
        '/',
        '/events',
      ]);
    }
    return created;
  }

  /**
   * Public list: ACTIVE only (COMPLETED for `archive`), never an event hidden from the
   * site, sorted by `eventDate.startDate` then `time.start`. Each item includes `soldOut`.
   */
  async findPublic(options?: FindPublicOptions): Promise<PublicEventListItem[]> {
    const parsedLimit = Number.parseInt(options?.limit ?? '', 10);
    const parsedOffset = Number.parseInt(options?.offset ?? '', 10);
    const hasLimit = Number.isFinite(parsedLimit) && parsedLimit > 0;
    const hasOffset = Number.isFinite(parsedOffset) && parsedOffset >= 0;

    const filter: mongoose.FilterQuery<IEvent> = {
      status: { $in: ['ACTIVE'] },
      ...VISIBLE_ON_SITE_FILTER,
    };
    // `top` keeps the historical behaviour (one-off events); `regular` is the new
    // recurring section. No `kind` at all still returns everything, as before.
    // `archive` lists finished events (COMPLETED) for the public archive section.
    if (options?.kind === 'regular') {
      filter['recurrence.enabled'] = true;
    } else if (options?.kind === 'top') {
      filter['recurrence.enabled'] = { $ne: true };
    } else if (options?.kind === 'archive') {
      filter.status = { $in: ['COMPLETED'] };
    }

    let query = this.eventModel
      .find(filter)
      .sort(
        options?.kind === 'archive'
          ? { 'eventDate.startDate': -1, 'time.start': -1 }
          : { 'eventDate.startDate': 1, 'time.start': 1 },
      );

    if (hasOffset) {
      query = query.skip(parsedOffset);
    }
    if (hasLimit) {
      query = query.limit(parsedLimit);
    }

    const eventsRaw = (await query
      .lean()
      .exec()) as IEvent[];
    const events = await Promise.all(eventsRaw.map((event) => this.ensureEventMediaIds(event)));

    const [countersByEvent, onSaleRemaining, ratings] = await Promise.all([
      this.buildZoneCountersForEvents(this.oneOffEventIds(events)),
      this.onSaleRemainingFor(events),
      this.reviewsService.ratingsForEvents(events.map((event) => event.id)),
    ]);
    const now = Date.now();
    return events.map((event): PublicEventListItem => {
      const countersByZone = countersByEvent.get(event.id);
      const sessionRemaining = this.sessionRemainingOf(event, onSaleRemaining);
      const rating = ratings.get(event.id);

      const withAvailability = this.withoutPrivateFields(
        this.applyAvailabilityToEvent(event, countersByZone, false, sessionRemaining),
      );
      const remaining = this.remainingPurchasableSeats(event, countersByZone, sessionRemaining);
      return {
        ...withAvailability,
        soldOut: remaining === 0,
        salesEnded: isEventSalesEnded(event, now),
        // Ratings only mean something for regular events; a one-off never carries one.
        ...(rating && this.isRecurring(event)
          ? { ratingAvg: rating.ratingAvg, ratingCount: rating.ratingCount }
          : {}),
      };
    });
  }

  /** Public payload for a specific set of event ids (used by favourites). Hidden events drop out. */
  async findPublicByIds(eventIds: number[]): Promise<PublicEventListItem[]> {
    if (!eventIds.length) return [];
    const eventsRaw = (await this.eventModel
      .find({ id: { $in: eventIds }, status: { $in: ['ACTIVE'] }, ...VISIBLE_ON_SITE_FILTER })
      .lean()
      .exec()) as IEvent[];
    const events = await Promise.all(eventsRaw.map((event) => this.ensureEventMediaIds(event)));

    const [countersByEvent, onSaleRemaining, ratings] = await Promise.all([
      this.buildZoneCountersForEvents(this.oneOffEventIds(events)),
      this.onSaleRemainingFor(events),
      this.reviewsService.ratingsForEvents(events.map((event) => event.id)),
    ]);

    const now = Date.now();
    return events.map((event): PublicEventListItem => {
      const countersByZone = countersByEvent.get(event.id);
      const sessionRemaining = this.sessionRemainingOf(event, onSaleRemaining);
      const rating = ratings.get(event.id);
      const withAvailability = this.withoutPrivateFields(
        this.applyAvailabilityToEvent(event, countersByZone, false, sessionRemaining),
      );
      const remaining = this.remainingPurchasableSeats(event, countersByZone, sessionRemaining);
      return {
        ...withAvailability,
        soldOut: remaining === 0,
        salesEnded: isEventSalesEnded(event, now),
        // Ratings only mean something for regular events; a one-off never carries one.
        ...(rating && this.isRecurring(event)
          ? { ratingAvg: rating.ratingAvg, ratingCount: rating.ratingCount }
          : {}),
      };
    });
  }

  /**
   * The event an admin pinned (home-hero) while it is on the site; otherwise the nearest ACTIVE
   * with tickets on sale; otherwise the first sorted ACTIVE (sold out or past its sales cut-off).
   * Events hidden from the site, and events already over (`isEventOver` — ACTIVE until the nightly
   * completion cron), are never candidates while another one is left.
   */
  async getHeroEvent(): Promise<PublicEventListItem> {
    const [eventsRaw, pinnedId] = await Promise.all([
      this.eventModel
        .find({ status: { $in: ['ACTIVE'] }, ...VISIBLE_ON_SITE_FILTER })
        .sort({ 'eventDate.startDate': 1, 'time.start': 1 })
        .lean()
        .exec() as Promise<IEvent[]>,
      featuredHomeHeroEventId(),
    ]);

    if (!eventsRaw.length) {
      throw new NotFoundException('No hero event available');
    }

    const events = await Promise.all(eventsRaw.map((event) => this.ensureEventMediaIds(event)));
    // Same availability arithmetic as the lists: a regular event's capacity is per
    // session, so it reads the seats of its sessions still on sale.
    const [countersByEvent, onSaleRemaining] = await Promise.all([
      this.buildZoneCountersForEvents(this.oneOffEventIds(events)),
      this.onSaleRemainingFor(events),
    ]);
    const now = Date.now();
    const remainingOf = (event: IEvent) =>
      this.remainingPurchasableSeats(event, countersByEvent.get(event.id), this.sessionRemainingOf(event, onSaleRemaining));
    const upcoming = events.filter((event) => !isEventOver(event, now));
    // A one-off past its sales cut-off cannot be bought either: same as sold out here.
    const hero =
      upcoming.find((event) => event.id === pinnedId) ??
      upcoming.find((event) => remainingOf(event) !== 0 && !isEventSalesEnded(event, now)) ??
      upcoming[0] ??
      events[0];
    const countersByZone = countersByEvent.get(hero.id);
    const sessionRemaining = this.sessionRemainingOf(hero, onSaleRemaining);
    const withAvailability = this.withoutPrivateFields(
      this.applyAvailabilityToEvent(hero, countersByZone, false, sessionRemaining),
    );
    return { ...withAvailability, soldOut: remainingOf(hero) === 0, salesEnded: isEventSalesEnded(hero, now) };
  }

  /** Find event by numeric id (for internal use, e.g. mock orders). */
  async findOneByNumericId(eventId: number): Promise<IEvent> {
    const event = await this.eventModel.findOne({ id: eventId }).lean().exec();
    if (!event) {
      throw new NotFoundException('Event not found');
    }
    const normalizedEvent = await this.ensureEventMediaIds(event as IEvent);
    const countersByZone = (await this.buildZoneCountersForEvents([normalizedEvent.id])).get(normalizedEvent.id);
    return this.applyAvailabilityToEvent(normalizedEvent, countersByZone, true);
  }

  /**
   * Public single event by slug. Slug format: "id-title-part" (e.g. "1-neon-horizons").
   * Parses numeric id from the start and returns event if ACTIVE or DRAFT.
   * Includes event-level `soldOut`; zones include `remaining_tickets` (derive zone sold-out from that).
   */
  async findOnePublicBySlug(slug: string): Promise<PublicEventListItem> {
    const idPart = slug.trim().split('-')[0];
    const n = parseInt(idPart, 10);
    if (Number.isNaN(n)) {
      throw new NotFoundException('Event not found');
    }
    // COMPLETED/CANCELLED stay reachable on purpose: a finished event keeps its
    // page (frontend swaps the purchase card for an "event is over" plate)
    // instead of turning into a 404 and losing the long-tail search traffic.
    // An event the organizer hid from the site is a 404, like a non-public one.
    const event = (await this.eventModel
      .findOne({
        id: n,
        status: { $in: ['ACTIVE', 'DRAFT', 'COMPLETED', 'CANCELLED'] },
        ...VISIBLE_ON_SITE_FILTER,
      })
      .lean()
      .exec()) as IEvent | null;
    if (!event) {
      throw new NotFoundException('Event not found');
    }
    const normalizedEvent = await this.ensureEventMediaIds(event);
    const [countersByEvent, onSaleRemaining] = await Promise.all([
      this.buildZoneCountersForEvents(this.oneOffEventIds([normalizedEvent])),
      this.onSaleRemainingFor([normalizedEvent]),
    ]);
    const countersByZone = countersByEvent.get(normalizedEvent.id);
    const sessionRemaining = this.sessionRemainingOf(normalizedEvent, onSaleRemaining);
    const withAvailability = this.withoutPrivateFields(
      this.applyAvailabilityToEvent(normalizedEvent, countersByZone, false, sessionRemaining),
    );
    const remaining = this.remainingPurchasableSeats(normalizedEvent, countersByZone, sessionRemaining);
    const rating = await this.reviewsService.ratingForEvent(normalizedEvent.id);
    return {
      ...withAvailability,
      soldOut: remaining === 0,
      salesEnded: isEventSalesEnded(normalizedEvent),
      ratingAvg: rating.ratingAvg,
      ratingCount: rating.ratingCount,
    };
  }

  /**
   * Can be reused from other services when availability is needed by event id.
   */
  async findOneWithAvailabilityByNumericId(eventId: number): Promise<IEvent> {
    const event = await this.findOneByNumericId(eventId);
    const countersByEvent = await this.buildZoneCountersForEvents([event.id]);
    return this.applyAvailabilityToEvent(event, countersByEvent.get(event.id)) as IEvent;
  }

  async findAll(
    creatorId: string,
    status?: string,
    search?: string,
    assignedEventIds?: number[],
    archived?: 'only' | 'exclude',
  ): Promise<Array<IEventPlain & { statistics: OwnerEventStatistics }>> {
    const filter: Record<string, unknown> = { creator: Number(creatorId), softDeleted: { $ne: true } };
    // Organizer archive tab: `only` = the archive, `exclude` = everything else, absent = all.
    if (archived === 'only') {
      filter.archivedByOrganizer = true;
    } else if (archived === 'exclude') {
      filter.archivedByOrganizer = { $ne: true };
    }
    if (Array.isArray(assignedEventIds)) {
      const normalizedAssignedIds = Array.from(
        new Set(assignedEventIds.filter((eventId) => Number.isInteger(eventId) && eventId > 0)),
      );
      filter.id = { $in: normalizedAssignedIds };
    }
    if (status?.trim() && EVENT_STATUSES.includes(status as any)) {
      filter.status = status.trim();
    }
    if (search?.trim()) {
      const term = search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(term, 'i');
      filter.$or = [
        { 'title.th': re },
        { 'title.en': re },
        { 'title.ru': re },
      ];
    }
    const events = await this.eventModel
      .find(filter)
      .sort({ createdAt: -1 })
      .lean()
      .exec() as IEvent[];
    const withMedia = await Promise.all(events.map((event) => this.ensureEventMediaIds(event)));
    return Promise.all(
      withMedia.map(async (event) => ({
        ...event,
        // Always a boolean: events saved before the flag existed carry no field.
        hiddenFromSite: event.hiddenFromSite === true,
        archivedByOrganizer: event.archivedByOrganizer === true,
        statistics: await this.getOwnerEventStatistics(String(event.id), creatorId),
      })),
    );
  }

  async getOwnerEventStatistics(id: string, creatorId: string): Promise<OwnerEventStatistics> {
    const event = await this.findOne(id, creatorId);
    return this.buildOwnerEventStatisticsFromEvent(event);
  }

  /** Same payload as organizer statistics, without creator ownership check (admin). */
  async getAdminEventStatistics(id: string): Promise<OwnerEventStatistics> {
    const event = await this.findEventByNumericId(id);
    return this.buildOwnerEventStatisticsFromEvent(event);
  }

  /**
   * Sales per show for a regular event.
   *
   * Capacity here is the zone capacity of a *single* performance, because that is what
   * each session actually sells. Disabled, sold-out and cancelled sessions are included
   * so the organizer still sees what was sold; only an `active` show still on sale (before
   * its sales cut-off, `salesClosed` — a show that has started always is) has seats
   * remaining: the unsold seats of a show that already took place are not "left".
   */
  private async buildSessionStatistics(event: IEvent): Promise<OwnerSessionStatistics[]> {
    if (!this.isRecurring(event)) return [];

    // Revenue per show: paid order lines, `price × count` — the one aggregation the
    // schedule guards and the edit form's sales summary share.
    const now = Date.now();
    const [sessions, soldBySession, reopenableIds] = await Promise.all([
      this.eventSessionsService.getSessionsWithAvailability(event.id, { includeDisabled: true, now }),
      this.eventSessionsService.soldCountersBySession(event.id),
      this.eventSessionsService.reopenableSessionIds(event.id, now),
    ]);

    return sessions.map((session) => {
      const capacity = session.zones.reduce((sum, zone) => sum + (zone.seats ?? 0), 0);
      const sold = session.zones.reduce((sum, zone) => sum + zone.bought, 0);
      const reserved = session.zones.reduce((sum, zone) => sum + zone.reserved, 0);
      return {
        sessionId: session.id,
        date: session.date,
        start: session.start,
        end: session.end,
        status: session.status,
        capacity,
        sold,
        reserved,
        remaining:
          session.status === 'active' && !session.salesClosed
            ? Math.max(capacity - sold - reserved, 0)
            : 0,
        fillingPercentage: capacity > 0 ? Math.round((sold / capacity) * 1000) / 10 : 0,
        revenue: soldBySession.get(session.id)?.paidAmount ?? 0,
        reopenable: reopenableIds.has(session.id),
      };
    });
  }

  private async buildOwnerEventStatisticsFromEvent(event: IEvent): Promise<OwnerEventStatistics> {
    const eventNumericId = event.id;

    const sessionStatistics = await this.buildSessionStatistics(event);
    const isRecurringEvent = this.isRecurring(event);

    /**
     * A regular event offers its zone capacity once per scheduled session, so the
     * event-wide total has to scale with the schedule. Counting it once would report a
     * capacity smaller than the tickets already sold. A sold-out show still counts
     * (its seats were offered); a disabled or cancelled one does not.
     */
    let seatsPerShow = 0;
    for (const sector of event.sectors ?? []) {
      for (const zone of sector.zones ?? []) {
        seatsPerShow += zone.seats ?? 0;
      }
    }
    const scheduledSessionCount = sessionStatistics.filter(
      (s) => s.status === 'active' || s.status === 'sold_out',
    ).length;
    const totalTicketsAllZones = isRecurringEvent
      ? seatsPerShow * scheduledSessionCount
      : seatsPerShow;

    const countersByEvent = await this.buildZoneCountersForEvents([eventNumericId]);
    const countersByZone = countersByEvent.get(eventNumericId);
    let ticketsRemainingToBuy = 0;
    if (isRecurringEvent) {
      ticketsRemainingToBuy = sessionStatistics
        .filter((s) => s.status === 'active')
        .reduce((sum, s) => sum + s.remaining, 0);
    } else {
      for (const sector of event.sectors ?? []) {
        for (const zone of sector.zones ?? []) {
          const counters = countersByZone?.get(this.zoneKey(sector.id, zone.id));
          const reserved = counters?.reserved ?? 0;
          const bought = counters?.bought ?? 0;
          ticketsRemainingToBuy += Math.max((zone.seats ?? 0) - reserved - bought, 0);
        }
      }
    }

    const [ticketsBought, ticketsUsedSuccessfully, profitAgg] = await Promise.all([
      this.ticketModel.countDocuments({ eventId: eventNumericId }).exec(),
      this.ticketModel.countDocuments({ eventId: eventNumericId, status: 'USED' }).exec(),
      this.mockOrderModel
        .aggregate<{ total: number }>([
          { $match: { event: eventNumericId, status: 'paid' } },
          { $group: { _id: null, total: { $sum: '$total_price' } } },
        ])
        .exec(),
    ]);

    const profitFromBoughtTickets = profitAgg[0]?.total ?? 0;

    const zoneStatistics = this.buildOwnerZoneStatisticsArray(event, countersByZone);

    return {
      id: eventNumericId,
      name: event.title,
      totalTicketsAllZones,
      ticketsBought,
      ticketsRemainingToBuy,
      profitFromBoughtTickets,
      fillingPercentage:
        totalTicketsAllZones > 0 ? (ticketsUsedSuccessfully / totalTicketsAllZones) * 100 : 0,
      ticketsUsedSuccessfully,
      zoneStatistics,
      sessionStatistics,
      hiddenFromSite: event.hiddenFromSite === true,
      archivedByOrganizer: event.archivedByOrganizer === true,
    };
  }

  /**
   * Ticket sales breakdown by sector/zone (creator-owned event).
   * avgTicketPrice = sum(paid mock orders' total_price) / soldTicketsCount (ticket documents).
   * With a show-date period and/or a session the breakdown covers only those shows;
   * without one the output is exactly the historical event-wide breakdown.
   */
  async getEventTicketSalesStatistics(
    eventId: number,
    creatorUserId: string,
    period?: SessionPeriodFilter,
  ): Promise<EventTicketSalesStatistics> {
    const filter = normalizeSessionPeriodFilter(period);
    const event = await this.findOne(String(eventId), creatorUserId);
    return filter
      ? this.buildPeriodTicketSalesStatistics(event, filter)
      : this.buildEventTicketSalesStatisticsFromEvent(event);
  }

  /**
   * Same as ticket sales statistics without creator ownership check (admin), including
   * the optional show-date period / session.
   */
  async getAdminEventTicketSalesStatistics(
    eventId: number,
    period?: SessionPeriodFilter,
  ): Promise<EventTicketSalesStatistics> {
    const filter = normalizeSessionPeriodFilter(period);
    const event = await this.findEventByNumericId(String(eventId));
    return filter
      ? this.buildPeriodTicketSalesStatistics(event, filter)
      : this.buildEventTicketSalesStatisticsFromEvent(event);
  }

  private async buildEventTicketSalesStatisticsFromEvent(
    event: IEvent,
  ): Promise<EventTicketSalesStatistics> {
    const eventNumericId = event.id;

    const countersByEvent = await this.buildZoneCountersForEvents([eventNumericId]);
    const countersByZone = countersByEvent.get(eventNumericId);

    const sectors = event.sectors ?? [];
    const sectorsCount = sectors.length;

    const [soldTicketsCount, paidTotalAgg] = await Promise.all([
      this.ticketModel.countDocuments({ eventId: eventNumericId }).exec(),
      this.mockOrderModel
        .aggregate<{ sum: number }>([
          { $match: { event: eventNumericId, status: 'paid' } },
          { $group: { _id: null, sum: { $sum: '$total_price' } } },
        ])
        .exec(),
    ]);

    const sumPaidTotalPrice = paidTotalAgg[0]?.sum ?? 0;
    const remainingTicketsCount = this.remainingPurchasableSeats(event, countersByZone);
    const avgTicketPrice =
      soldTicketsCount > 0 ? sumPaidTotalPrice / soldTicketsCount : 0;

    const sectorsInfo = sectors.map((sector) => {
      const zones = sector.zones ?? [];
      let allTicketsCount = 0;
      let soldTicketsCountSector = 0;
      let remainingTicketsCountSector = 0;
      const zonePricesForRange: number[] = [];

      const zonesInfo = zones.map((zone) => {
        const allCount = zone.seats ?? 0;
        const counters = countersByZone?.get(this.zoneKey(sector.id, zone.id));
        const reserved = counters?.reserved ?? 0;
        const bought = counters?.bought ?? 0;
        const remaining = Math.max(allCount - reserved - bought, 0);
        const price = zone.isFree ? 0 : zone.price;
        zonePricesForRange.push(price);

        allTicketsCount += allCount;
        soldTicketsCountSector += bought;
        remainingTicketsCountSector += remaining;

        return {
          id: zone.id,
          name: zone.name,
          price,
          allTicketsCount: allCount,
          soldTicketsCount: bought,
          remainingTicketsCount: remaining,
        };
      });

      const priceRange =
        zonePricesForRange.length > 0
          ? {
              min: Math.min(...zonePricesForRange),
              max: Math.max(...zonePricesForRange),
            }
          : { min: 0, max: 0 };

      return {
        id: sector.id,
        name: sector.name,
        priceRange,
        allTicketsCount,
        soldTicketsCount: soldTicketsCountSector,
        remainingTicketsCount: remainingTicketsCountSector,
        zonesInfo,
      };
    });

    return {
      sectorsCount,
      soldTicketsCount,
      remainingTicketsCount,
      avgTicketPrice,
      sectorsInfo,
    };
  }

  /**
   * The same breakdown restricted to a show-date period and/or one session (the Tickets
   * tab's period filter). Per zone:
   *  - capacity: `seats` × the period's shows still offered (`active` or `sold_out`) —
   *    a cancelled or disabled show offered nothing;
   *  - sold: issued tickets of the period's shows, cancelled shows included;
   *  - reserved: unpaid (`wait` / `pending_cash`) order lines of those shows;
   *  - remaining: summed per `active` show still on sale (before the event's sales cut-off,
   *    the per-session `salesClosed` rule), `max(seats - sold - reserved, 0)` each, so a
   *    sold-out, cancelled or already started (played) show adds nothing — the same
   *    `remaining` the per-session table reports.
   * avgTicketPrice divides the paid orders' `total_price`, each scaled by the order's
   * share of the period, by the tickets sold in it. A one-off event is a single show
   * dated by `eventDate.startDate`: inside the period it reads exactly like the
   * unfiltered breakdown, outside it every counter is zero.
   */
  private async buildPeriodTicketSalesStatistics(
    event: IEvent,
    filter: SessionPeriodFilter,
  ): Promise<EventTicketSalesStatistics> {
    const eventNumericId = event.id;
    const scope = await this.eventSessionsService.resolvePeriodScope(event, filter);

    type ShowZoneRow = {
      _id: { session?: number | null; sector: string; zone: string };
      count: number;
    };
    const [soldRows, reservedRows, paidTotalAgg] = isEmptyPeriodScope(scope)
      ? [[] as ShowZoneRow[], [] as ShowZoneRow[], [] as Array<{ sum: number }>]
      : await Promise.all([
          this.ticketModel
            .aggregate<ShowZoneRow>([
              { $match: { eventId: eventNumericId, ...periodTicketQuery(scope) } },
              {
                $group: {
                  _id: { session: '$session', sector: '$sector', zone: '$zone' },
                  count: { $sum: 1 },
                },
              },
            ])
            .exec(),
          this.mockOrderModel
            .aggregate<ShowZoneRow>([
              {
                $match: {
                  event: eventNumericId,
                  status: { $in: ['wait', 'pending_cash'] },
                  ...periodLinesQuery(scope, 'tickets'),
                },
              },
              { $unwind: '$tickets' },
              { $match: periodTicketQuery(scope, 'tickets.session') },
              {
                $group: {
                  _id: {
                    session: '$tickets.session',
                    sector: '$tickets.sectorId',
                    zone: '$tickets.zoneId',
                  },
                  count: { $sum: '$tickets.count' },
                },
              },
            ])
            .exec(),
          this.mockOrderModel
            .aggregate<{ sum: number }>([
              {
                $match: {
                  event: eventNumericId,
                  status: 'paid',
                  ...periodLinesQuery(scope, 'tickets'),
                },
              },
              {
                $group: {
                  _id: null,
                  sum: { $sum: { $multiply: ['$total_price', periodShareExpr(scope)] } },
                },
              },
            ])
            .exec(),
        ]);

    // `null` stands for a session-less (one-off) line.
    const showOf = (row: ShowZoneRow) =>
      typeof row._id.session === 'number' ? row._id.session : null;
    const showZoneKey = (show: number | null, zoneKey: string) => `${show ?? '-'}|${zoneKey}`;
    /** Whole-period totals per zone, and per `(show, zone)` for the remaining seats. */
    const perZone = new Map<string, ZoneTicketCounters>();
    const perShow = new Map<string, ZoneTicketCounters>();
    const add = (
      map: Map<string, ZoneTicketCounters>,
      key: string,
      field: keyof ZoneTicketCounters,
      by: number,
    ) => {
      const counters = map.get(key) ?? { reserved: 0, bought: 0 };
      counters[field] += by;
      map.set(key, counters);
    };
    for (const [rows, field] of [
      [soldRows, 'bought'],
      [reservedRows, 'reserved'],
    ] as Array<[ShowZoneRow[], keyof ZoneTicketCounters]>) {
      for (const row of rows) {
        const zoneKey = this.zoneKey(row._id.sector, row._id.zone);
        add(perZone, zoneKey, field, row.count ?? 0);
        add(perShow, showZoneKey(showOf(row), zoneKey), field, row.count ?? 0);
      }
    }

    const isRecurringEvent = this.isRecurring(event);
    // Shows that offered seats in the period, and the ones that can still sell.
    const offeredShowCount = isRecurringEvent
      ? scope.sessions.filter((s) => s.status === 'active' || s.status === 'sold_out').length
      : scope.sessionlessMatch
        ? 1
        : 0;
    const now = Date.now();
    const openShows: Array<number | null> = isRecurringEvent
      ? scope.sessions
          .filter(
            (s) => s.status === 'active' && !isSessionSalesClosed(s, event.salesCloseBefore, now),
          )
          .map((s) => s.id)
      : scope.sessionlessMatch
        ? [null]
        : [];

    const sectors = event.sectors ?? [];
    const soldTicketsCount = soldRows.reduce((sum, row) => sum + (row.count ?? 0), 0);
    let remainingTicketsCount = 0;

    const sectorsInfo = sectors.map((sector) => {
      let allTicketsCount = 0;
      let soldTicketsCountSector = 0;
      let remainingTicketsCountSector = 0;
      const zonePricesForRange: number[] = [];

      const zonesInfo = (sector.zones ?? []).map((zone) => {
        const seats = zone.seats ?? 0;
        const zoneKey = this.zoneKey(sector.id, zone.id);
        const allCount = seats * offeredShowCount;
        const bought = perZone.get(zoneKey)?.bought ?? 0;
        let remaining = 0;
        for (const show of openShows) {
          const counters = perShow.get(showZoneKey(show, zoneKey));
          remaining += Math.max(seats - (counters?.bought ?? 0) - (counters?.reserved ?? 0), 0);
        }
        const price = zone.isFree ? 0 : zone.price;
        zonePricesForRange.push(price);

        allTicketsCount += allCount;
        soldTicketsCountSector += bought;
        remainingTicketsCountSector += remaining;

        return {
          id: zone.id,
          name: zone.name,
          price,
          allTicketsCount: allCount,
          soldTicketsCount: bought,
          remainingTicketsCount: remaining,
        };
      });
      remainingTicketsCount += remainingTicketsCountSector;

      return {
        id: sector.id,
        name: sector.name,
        priceRange:
          zonePricesForRange.length > 0
            ? { min: Math.min(...zonePricesForRange), max: Math.max(...zonePricesForRange) }
            : { min: 0, max: 0 },
        allTicketsCount,
        soldTicketsCount: soldTicketsCountSector,
        remainingTicketsCount: remainingTicketsCountSector,
        zonesInfo,
      };
    });

    const sumPaidTotalPrice = paidTotalAgg[0]?.sum ?? 0;
    return {
      sectorsCount: sectors.length,
      soldTicketsCount,
      remainingTicketsCount,
      avgTicketPrice: soldTicketsCount > 0 ? sumPaidTotalPrice / soldTicketsCount : 0,
      sectorsInfo,
    };
  }

  private buildOwnerZoneStatisticsArray(
    event: IEvent,
    countersByZone: Map<string, ZoneTicketCounters> | undefined,
  ): OwnerZoneStatistics[] {
    const zones: OwnerZoneStatistics[] = [];

    for (const sector of event.sectors ?? []) {
      for (const zone of sector.zones ?? []) {
        const allCount = zone.seats ?? 0;
        const counters = countersByZone?.get(this.zoneKey(sector.id, zone.id));
        const reserved = counters?.reserved ?? 0;
        const sold = counters?.bought ?? 0;
        const remaining = Math.max(allCount - reserved - sold, 0);
        zones.push({
          name: zone.name,
          price: zone.isFree ? 0 : zone.price,
          sold,
          remaining,
          allCount,
        });
      }
    }

    zones.sort((a, b) => {
      const ratio = (z: OwnerZoneStatistics) => (z.allCount > 0 ? z.sold / z.allCount : -1);
      return ratio(b) - ratio(a);
    });

    return zones;
  }

  /**
   * Load event by numeric id only (no creator filter). Use for admin paths that
   * still require the event to exist.
   */
  async findEventByNumericId(id: string): Promise<IEvent> {
    const n = parseInt(id, 10);
    if (Number.isNaN(n)) {
      throw new NotFoundException('Event not found');
    }
    const event = await this.eventModel.findOne({ id: n }).lean().exec();
    if (!event) {
      throw new NotFoundException('Event not found');
    }
    return this.ensureEventMediaIds(event as IEvent);
  }

  /**
   * The owned event exactly as stored — no media normalisation, no availability
   * counters. For organizer read paths that only need the document (ticket registry,
   * ticket PDF); same 404 as `findOne` for an unknown or foreign id. Takes the already
   * parsed id, the one the caller's manager-assignment check used.
   */
  async findOwnedEventDocument(eventId: number, creatorId: string): Promise<IEvent> {
    if (!Number.isSafeInteger(eventId)) {
      throw new NotFoundException('Event not found');
    }
    const event = await this.eventModel.findOne({ id: eventId, creator: Number(creatorId), softDeleted: { $ne: true } }).lean().exec();
    if (!event) {
      throw new NotFoundException('Event not found');
    }
    return event as IEvent;
  }

  /** id is event's numeric id (not MongoDB _id). */
  async findOne(id: string, creatorId: string): Promise<IEvent> {
    const n = parseInt(id, 10);
    if (Number.isNaN(n)) {
      throw new NotFoundException('Event not found');
    }
    const event = await this.eventModel.findOne({ id: n, creator: Number(creatorId), softDeleted: { $ne: true } }).lean().exec();
    if (!event) {
      throw new NotFoundException('Event not found');
    }
    const normalizedEvent = await this.ensureEventMediaIds(event as IEvent);
    const countersMap = await this.buildZoneCountersForEvents([normalizedEvent.id]);
    const countersByZone = countersMap.get(normalizedEvent.id);
    return {
      ...this.applyAvailabilityToEvent(normalizedEvent, countersByZone, true),
      // Always a boolean for the organizer cabinet: older events carry no field.
      hiddenFromSite: normalizedEvent.hiddenFromSite === true,
      archivedByOrganizer: normalizedEvent.archivedByOrganizer === true,
    } as unknown as IEvent;
  }

  /** id is event's numeric id. */
  /**
   * Canonical form for change detection: key order carries no meaning, mongo
   * bookkeeping (`_id`, `__v`) is not part of what an organizer submitted, and
   * absent, `null` and empty-string values all read as "not set".
   *
   * The empty-string rule matters: LocalizedTextSchema stores unfilled languages
   * as `''` while the organizer form sends only the filled ones, so without it
   * every stored `{th:'', en:'X', ru:''}` differed from a submitted `{en:'X'}` and
   * a description-only save bounced the event to moderation. Mirrors the client's
   * `canonicalizeForDiff` exactly — the two must agree or the save button lies.
   */
  private canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => this.canonicalize(item));
    if (value && typeof value === 'object') {
      const source = value as Record<string, unknown>;
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(source).sort()) {
        if (key === '_id' || key === '__v') continue;
        const inner = source[key];
        if (inner === undefined || inner === null || inner === '') continue;
        result[key] = this.canonicalize(inner);
      }
      return result;
    }
    return value;
  }

  private differs(before: unknown, after: unknown): boolean {
    return (
      JSON.stringify(this.canonicalize(before)) !== JSON.stringify(this.canonicalize(after))
    );
  }

  /**
   * Only the parts of the ticket structure an organizer actually submits. Live
   * counters (`sold_tickets`, `remaining_tickets`) live on the stored sectors but
   * never in the DTO, so comparing raw documents would flag every single save.
   */
  private organizerSectorShape(sectors: unknown): unknown {
    if (!Array.isArray(sectors)) return sectors;
    return sectors.map((sector) => {
      const s = sector as ISector;
      return {
        id: s.id,
        color: s.color,
        name: s.name,
        zones: (s.zones ?? []).map((zone) => ({
          id: zone.id,
          name: zone.name,
          seats: zone.seats,
          isFree: zone.isFree,
          price: zone.price,
          currency: zone.currency,
        })),
      };
    });
  }

  /**
   * Changes that alter what a customer bought (or is about to buy) and therefore
   * need a fresh moderation pass. Cosmetic edits — description, tags, cover, links,
   * venue working hours — deliberately stay outside this list and publish at once,
   * and so do `salesCloseBefore` and `ticketCopyEmail`: an organizer tuning when sales
   * stop or where ticket copies go is not a change to the event itself. The cash-payment
   * switch (`paymentOptions.cashEnabled`) is deliberately absent too: it applies immediately
   * and never costs a moderation pass.
   */
  /** Город заморожен, как только по событию появились деньги или билеты. */
  private async assertCityEditable(eventId: number): Promise<void> {
    const [hasTickets, hasOrders] = await Promise.all([
      this.ticketModel.exists({ eventId }).exec(),
      this.mockOrderModel
        .exists({ event: eventId, status: { $in: ['paid', 'pending_cash', 'wait'] } })
        .exec(),
    ]);
    if (hasTickets || hasOrders) {
      throw new BadRequestException('city_locked_after_sales');
    }
  }

  private hasSignificantChange(before: IEvent, dto: UpdateEventDto): boolean {
    if (dto.title !== undefined && this.differs(before.title, dto.title)) return true;
    /*
     * Смена города двигает событие между гео-афишами — это не косметика.
     * Но ПЕРВИЧНАЯ привязка старого события (before.city пуст) — не переезд:
     * иначе обычное сохранение формы снимало бы живое событие в модерацию.
     */
    if (dto.city !== undefined && before.city && before.city !== dto.city) return true;
    if (dto.eventDate !== undefined && this.differs(before.eventDate, dto.eventDate)) return true;
    if (dto.time !== undefined && this.differs(before.time, dto.time)) return true;
    if (dto.venue !== undefined && this.differs(before.venue, dto.venue)) return true;
    if (
      dto.sectors !== undefined &&
      this.differs(
        this.organizerSectorShape(before.sectors),
        this.organizerSectorShape(dto.sectors),
      )
    ) {
      return true;
    }
    if (dto.recurrence !== undefined) {
      // `enabled: false` means the schedule is being dropped altogether.
      const nextRecurrence = dto.recurrence.enabled === true ? dto.recurrence : undefined;
      if (this.differs(before.recurrence, nextRecurrence)) return true;
    }
    return false;
  }

  async update(id: string, dto: UpdateEventDto, creatorId: string): Promise<IEvent> {
    const n = parseInt(id, 10);
    if (Number.isNaN(n)) {
      throw new NotFoundException('Event not found');
    }
    const existing = await this.eventModel.findOne({ id: n }).exec();
    if (!existing) {
      throw new NotFoundException('Event not found');
    }
    if (existing.creator !== Number(creatorId)) {
      throw new ForbiddenException('You can only update your own events');
    }
    // An archived event is frozen: the organizer restores it first (409, nothing written).
    if (existing.archivedByOrganizer === true) {
      throw new ConflictException('event_archived');
    }
    // PartialType делает city необязательным, а IsOptional пропускает и null:
    // не даём null проскочить мимо IsIn и стереть город из документа.
    if ((dto as { city?: unknown }).city === null) {
      delete (dto as { city?: unknown }).city;
    }
    /*
     * Only a one-off event may be hidden from the site, so a hidden event cannot be
     * turned into a recurring one: the organizer returns it to the site first (400
     * `event_hidden_recurring_not_allowed`, before anything is written). An event that
     * is already recurring (hidden before this rule) keeps its schedule editable.
     * The final write re-checks it atomically (a concurrent hide may land meanwhile).
     */
    const becomesRecurring =
      dto.recurrence?.enabled === true && !this.isRecurring(existing.toObject() as IEvent);
    if (becomesRecurring && existing.hiddenFromSite === true) {
      throw new BadRequestException('event_hidden_recurring_not_allowed');
    }
    // A bad schedule must fail here, before the update (and any status flip) lands.
    this.assertRecurrenceBuildable(dto.recurrence as IRecurrence | undefined);
    /*
     * Same for a schedule that would strand buyers: fixed show times after the first sale
     * (409 `recurrence_times_locked`) and no dropping a show with sold tickets (409
     * `session_has_sales`). Checked before media uploads, moderation, sessions — before
     * anything of this update is written.
     */
    if (dto.recurrence !== undefined) {
      await this.eventSessionsService.assertScheduleChangeAllowed(
        existing.id,
        (existing.toObject() as IEvent).recurrence,
        dto.recurrence as IRecurrence,
      );
    }
    /*
     * Город после старта продаж заморожен: на него уже смотрят гео-страницы,
     * реклама и купленные билеты. Дозаполнить пустой city у старого события
     * можно — это не перенос, а первичная привязка.
     */
    if (dto.city !== undefined && existing.city && dto.city !== existing.city) {
      await this.assertCityEditable(existing.id);
    }
    if (dto.sectors) {
      await this.assertSoldTicketStructureEditable(
        existing as unknown as IEvent,
        dto.sectors as Array<Pick<ISector, 'id' | 'name' | 'zones'>>,
      );
      await this.assertNoPendingOrCompletedMockOrdersOnRemovedZones(
        existing as unknown as IEvent,
        dto.sectors as Array<Pick<ISector, 'id' | 'zones'>>,
      );
    }
    const {
      status: requestedStatus,
      paymentOptions: requestedPaymentOptions,
      ...dtoWithoutStatus
    } = dto;
    const canSetDraftOrModeration =
      existing.status === 'DRAFT' ||
      existing.status === 'MODERATION' ||
      existing.status === 'REJECTED';
    if (requestedStatus !== undefined) {
      if (!canSetDraftOrModeration) {
        throw new BadRequestException(
          'Status cannot be changed on this event; omit `status` from the request body.',
        );
      }
    }

    const creator = Number(creatorId);
    const setPayload: Record<string, unknown> = { ...dtoWithoutStatus };
    if (requestedStatus !== undefined && canSetDraftOrModeration) {
      setPayload.status = requestedStatus;
    }
    let oldCoverIdToRemove: number | undefined;
    let oldSeatingIdToRemove: number | undefined;
    let oldParkingIdToRemove: number | undefined;
    let oldPaymentQrCodeImageToRemove: number | undefined;

    if (dto.coverImage) {
      const currentCoverId = this.parseMediaId((existing as any).coverImage);
      const nextCoverId = await this.createMediaIdFromImageData(dto.coverImage, creator);
      setPayload.coverImage = nextCoverId;
      if (currentCoverId && currentCoverId !== nextCoverId) {
        oldCoverIdToRemove = currentCoverId;
      }
    }

    // The submitted gallery list is authoritative (order included); photos the
    // organizer dropped are deleted after the update lands.
    let oldGalleryIdsToRemove: number[] = [];
    if (dto.galleryImages !== undefined) {
      const currentGallery = (existing.galleryImages ?? []) as number[];
      const resolved = await this.resolveGalleryImages(dto.galleryImages, creator, currentGallery);
      setPayload.galleryImages = resolved.ids.length ? resolved.ids : undefined;
      oldGalleryIdsToRemove = resolved.removed;
    }

    if (dto.seatingPlanImage) {
      const currentSeatingId = this.parseMediaId((existing as any).seatingPlanImage);
      const nextSeatingId = await this.createMediaIdFromImageData(dto.seatingPlanImage, creator);
      setPayload.seatingPlanImage = nextSeatingId;
      if (currentSeatingId && currentSeatingId !== nextSeatingId) {
        oldSeatingIdToRemove = currentSeatingId;
      }
    }

    if (dto.parkingPlanImage) {
      const currentParkingId = this.parseMediaId((existing as any).parkingPlanImage);
      const nextParkingId = await this.createMediaIdFromImageData(dto.parkingPlanImage, creator);
      setPayload.parkingPlanImage = nextParkingId;
      if (currentParkingId && currentParkingId !== nextParkingId) {
        oldParkingIdToRemove = currentParkingId;
      }
    }

    if (requestedPaymentOptions) {
      const paymentOptionsResult = await this.resolvePaymentOptionsForSave(
        requestedPaymentOptions,
        creator,
        existing as unknown as IEvent,
        requestedStatus !== 'DRAFT',
      );
      setPayload.paymentOptions = paymentOptionsResult.paymentOptions;
      oldPaymentQrCodeImageToRemove = paymentOptionsResult.oldQrCodeImageToRemove;
    }

    /*
     * A published event may not change under its customers. Touching the title, the
     * schedule, the venue, the date or the ticket structure sends it back to
     * moderation exactly like a fresh submission — the event leaves the site until an
     * admin approves it again. Cosmetic edits (description, tags, cover, venue
     * working hours) still publish immediately.
     *
     * Scoped to ACTIVE: PAUSED must stay paused after an edit rather than be
     * published by an approval, and COMPLETED/CANCELLED are terminal.
     */
    const returnsToModeration =
      existing.status === 'ACTIVE' &&
      this.hasSignificantChange(existing.toObject() as IEvent, dto);
    if (returnsToModeration) {
      setPayload.status = 'MODERATION';
    }

    // Switching an event back to one-off drops the schedule; sessions are then
    // cleaned up (or disabled where already sold) by `syncSessions` below.
    const dropsRecurrence = dto.recurrence !== undefined && dto.recurrence.enabled !== true;
    if (dropsRecurrence) {
      delete setPayload.recurrence;
    }

    const updateOp: mongoose.UpdateQuery<IEvent> = { $set: setPayload };
    if (existing.status === 'REJECTED' && requestedStatus !== undefined) {
      updateOp.$unset = { rejectReason: 1 };
    }
    if (dropsRecurrence) {
      updateOp.$unset = { ...(updateOp.$unset as object), recurrence: 1 };
    }
    // An emptied gallery is removed outright, not stored as `null`.
    if (dto.galleryImages !== undefined && setPayload.galleryImages === undefined) {
      delete setPayload.galleryImages;
      updateOp.$unset = { ...(updateOp.$unset as object), galleryImages: 1 };
    }
    // `ticketCopyEmail: ''` (or null) switches the ticket copy off: the field is removed.
    if (dto.ticketCopyEmail !== undefined && !dto.ticketCopyEmail) {
      delete setPayload.ticketCopyEmail;
      updateOp.$unset = { ...(updateOp.$unset as object), ticketCopyEmail: 1 };
    }
    // Turning a one-off into a recurring event only matches while it is not hidden, so
    // a "hide from site" that landed after the check above cannot leave both behind.
    // Same for an archive that landed during the save (uploads take seconds): no write.
    const event = await this.eventModel
      .findOneAndUpdate(
        becomesRecurring
          ? { id: n, archivedByOrganizer: { $ne: true }, hiddenFromSite: { $ne: true } }
          : { id: n, archivedByOrganizer: { $ne: true } },
        updateOp,
        { new: true },
      )
      .lean()
      .exec();
    if (!event) {
      if (await this.eventModel.exists({ id: n, archivedByOrganizer: true })) {
        throw new ConflictException('event_archived');
      }
      if (becomesRecurring && (await this.eventModel.exists({ id: n, hiddenFromSite: true }))) {
        throw new BadRequestException('event_hidden_recurring_not_allowed');
      }
      throw new NotFoundException('Event not found');
    }
    if (oldCoverIdToRemove) {
      await this.mediaService.removeById(oldCoverIdToRemove);
    }
    for (const id of oldGalleryIdsToRemove) {
      await this.mediaService.removeById(id);
    }
    if (oldSeatingIdToRemove) {
      await this.mediaService.removeById(oldSeatingIdToRemove);
    }
    if (oldParkingIdToRemove) {
      await this.mediaService.removeById(oldParkingIdToRemove);
    }
    if (oldPaymentQrCodeImageToRemove) {
      await this.mediaService.removeById(oldPaymentQrCodeImageToRemove);
    }
    this.logger.log(`Event updated: ${id}`);
    const updated = await this.ensureEventMediaIds(event as IEvent);
    if (dto.recurrence !== undefined) {
      await this.syncSessions(updated);
    }
    // Any publicly visible state (published, changed, taken off sale) is worth
    // a re-crawl ping; drafts and moderation are not public yet.
    if (['ACTIVE', 'COMPLETED', 'CANCELLED'].includes(updated.status)) {
      this.indexNowService.notifyPaths([
        this.indexNowService.eventPath(updated.id, updated.title?.en),
        '/events',
      ]);
    }
    // TEMP: moderation notice to the Telegram support group is disabled — uncomment to restore.
    // `returnsToModeration` covers a published event re-submitted by a significant
    // edit; the second clause covers an organizer re-submitting a draft/rejected one.
    // const movedToModeration =
    //   returnsToModeration ||
    //   (requestedStatus === 'MODERATION' && existing.status !== 'MODERATION');
    // if (movedToModeration) {
    //   void this.supportMessagesService.notifyEventModerationChannel({
    //     eventId: updated.id,
    //     title: this.pickLocalizedTitle(updated.title),
    //     kind: 'status_changed',
    //   });
    // }
    // Event group chat (LINE): sales closed/opened by this edit (moderation, schedule, seats).
    void this.messengersNotifier
      .recheckSales(
        updated.id,
        returnsToModeration
          ? SALES_REASON.SENT_BACK_TO_MODERATION
          : dto.recurrence !== undefined
            ? SALES_REASON.SHOW_SCHEDULE_CHANGED
            : undefined,
      )
      .catch((err) => {
        this.logger.warn(`Messenger sales recheck failed for event ${updated.id}: ${(err as Error)?.message}`);
      });
    return updated;
  }

  /**
   * Public calendar feed for the purchase page: every session from today (ICT) the
   * buyer may see — on sale, sold out, cancelled (shown red), and a legacy flagless
   * `disabled` row whose slot is in the schedule (`salesClosed`; none left once
   * `healLegacyDisabledSessions` ran at boot) — each with its own `salesClosed`, plus the
   * cut-off rule so the page can explain it. Listing is not selling: every order path
   * accepts only `purchasableOnly` sessions. An event hidden from the site has no public
   * feed (404).
   */
  async getPublicSessions(eventId: number): Promise<{
    recurrence: IRecurrence | null;
    sessions: SessionWithAvailability[];
    salesCloseBefore: IEvent['salesCloseBefore'] | null;
  }> {
    const event = (await this.eventModel
      .findOne({ id: eventId, status: { $in: ['ACTIVE', 'DRAFT'] }, ...VISIBLE_ON_SITE_FILTER })
      .select({ id: 1, recurrence: 1, salesCloseBefore: 1 })
      .lean()
      .exec()) as Pick<IEvent, 'id' | 'recurrence' | 'salesCloseBefore'> | null;
    if (!event) {
      throw new NotFoundException('Event not found');
    }
    const salesCloseBefore = event.salesCloseBefore ?? null;
    if (!this.isRecurring(event)) {
      return { recurrence: null, sessions: [], salesCloseBefore };
    }
    // "Today" in ICT (not the UTC day, which lags Bangkok by 7 hours and would list
    // yesterday's shows every night); today's started shows come back salesClosed.
    const sessions = await this.eventSessionsService.getSessionsWithAvailability(eventId, {
      storefront: true,
    });
    return { recurrence: event.recurrence ?? null, sessions, salesCloseBefore };
  }

  /** Organizer cabinet: every session in every status, so each can be managed. */
  async getOwnerSessions(eventId: number, creatorId: string) {
    await this.assertOwnedEvent(eventId, creatorId);
    return this.eventSessionsService.getSessionsWithAvailability(eventId, {
      includeDisabled: true,
    });
  }

  /**
   * Organizer edit form pre-check of an owned event: whether the show times are locked
   * and which shows already have sold tickets (the ones a schedule edit may not drop).
   */
  async getOwnerSessionSalesSummary(eventId: number, creatorId: string): Promise<SessionSalesSummary> {
    await this.assertOwnedEvent(eventId, creatorId);
    return this.eventSessionsService.getSalesSummary(eventId);
  }

  /**
   * Organizer status action on sessions of an owned event: sell out, reopen or
   * cancel. The event document and its moderation status are never touched. Buyers
   * of cancelled sessions are e-mailed after the write, in the background.
   */
  async bulkSetSessionStatus(
    eventId: number,
    sessionIds: number[],
    status: OrganizerSessionStatus,
    creatorId: string,
  ): Promise<{ updated: number; sessions: SessionStatusSummary[]; notifiedOrders: number }> {
    await this.assertOwnedEvent(eventId, creatorId);
    const result = await this.eventSessionsService.bulkSetStatus(eventId, sessionIds, status);
    // Every requested session that is cancelled now, not only the ones this call changed:
    // buyers a half-finished earlier attempt never reached are still owed their letter.
    const cancelledIds =
      status === 'cancelled'
        ? result.sessions.filter((session) => session.status === 'cancelled').map((session) => session.id)
        : [];
    const notifiedOrders = await this.sessionCancellationNotifier.queueCancellationEmails(
      eventId,
      cancelledIds,
    );
    // Event group chat (LINE): the shows this call cancelled, then any sales edge it caused.
    if (result.changedIds.length) {
      void this.messengersNotifier
        .notifySessionsCancelled(eventId, status === 'cancelled' ? result.changedIds : [])
        .catch((err) => {
          this.logger.warn(`Messenger session-cancelled notification failed for event ${eventId}: ${(err as Error)?.message}`);
        })
        .then(() =>
          this.messengersNotifier.recheckSales(
            eventId,
            status === 'sold_out'
              ? SALES_REASON.SOLD_OUT
              : status === 'active'
                ? SALES_REASON.TICKETS_AVAILABLE_AGAIN
                : SALES_REASON.SHOW_SCHEDULE_CHANGED,
          ),
        )
        .catch((err) => {
          this.logger.warn(`Messenger sales recheck failed for event ${eventId}: ${(err as Error)?.message}`);
        });
    }
    return { updated: result.updated, sessions: result.sessions, notifiedOrders };
  }

  /** Single-session form of `bulkSetSessionStatus` (same rules, same e-mails). */
  async setSessionStatus(
    eventId: number,
    sessionId: number,
    status: OrganizerSessionStatus,
    creatorId: string,
  ): Promise<SessionWithAvailability | undefined> {
    await this.bulkSetSessionStatus(eventId, [sessionId], status, creatorId);
    const sessions = await this.eventSessionsService.getSessionsWithAvailability(eventId, {
      includeDisabled: true,
    });
    return sessions.find((session) => session.id === sessionId);
  }

  /**
   * Organizer "hide from site" / "return to site" (organizer or their Admin manager).
   * Writes only the three visibility fields with a direct `updateOne`: the status, the
   * moderation flow and every other field stay exactly as they are, whatever the status
   * (a hidden draft simply stays hidden once approved). Idempotent — repeating the
   * current state changes nothing, not even the timestamp.
   *
   * Only a one-off event may be hidden: hiding a recurring one is a 400
   * `event_hide_recurring_not_allowed`, before anything is written. Returning an event
   * to the site is always allowed, whatever its type.
   */
  async setHiddenFromSite(
    eventId: number,
    hidden: boolean,
    actor: { userId: string; managerId?: string },
  ): Promise<EventVisibilityResult> {
    await this.assertOwnedEvent(eventId, actor.userId);
    const current = (await this.eventModel
      .findOne({ id: eventId })
      .select({ id: 1, status: 1, title: 1, hiddenFromSite: 1, recurrence: 1, archivedByOrganizer: 1 })
      .lean()
      .exec()) as Pick<
      IEvent,
      'id' | 'status' | 'title' | 'hiddenFromSite' | 'recurrence' | 'archivedByOrganizer'
    > | null;
    if (!current) {
      throw new NotFoundException('Event not found');
    }
    // An archived event is already off the site; the organizer restores it first.
    if (current.archivedByOrganizer === true) {
      throw new ConflictException('event_archived');
    }
    if ((current.hiddenFromSite === true) === hidden) {
      return { id: current.id, hiddenFromSite: hidden, status: current.status };
    }
    if (hidden && this.isRecurring(current)) {
      throw new BadRequestException('event_hide_recurring_not_allowed');
    }

    const by = actor.managerId ? `manager:${actor.managerId}` : `user:${actor.userId}`;
    // `timestamps: false`: not an edit of the event, so `updatedAt` stays put too.
    // Hiding only matches a one-off, so an edit that made it recurring meanwhile wins.
    // An archive that landed meanwhile wins as well.
    const { matchedCount } = await this.eventModel
      .updateOne(
        hidden
          ? { id: eventId, archivedByOrganizer: { $ne: true }, 'recurrence.enabled': { $ne: true } }
          : { id: eventId, archivedByOrganizer: { $ne: true } },
        { $set: { hiddenFromSite: hidden, hiddenFromSiteAt: new Date(), hiddenFromSiteBy: by } },
        { timestamps: false },
      )
      .exec();
    if (matchedCount === 0) {
      const now = (await this.eventModel
        .findOne({ id: eventId })
        .select({ hiddenFromSite: 1, status: 1, archivedByOrganizer: 1 })
        .lean()
        .exec()) as Pick<IEvent, 'hiddenFromSite' | 'status' | 'archivedByOrganizer'> | null;
      if (!now) {
        throw new NotFoundException('Event not found');
      }
      if (now.archivedByOrganizer === true) {
        throw new ConflictException('event_archived');
      }
      if ((now.hiddenFromSite === true) === hidden) {
        return { id: current.id, hiddenFromSite: hidden, status: now.status };
      }
      throw new BadRequestException('event_hide_recurring_not_allowed');
    }
    this.logger.log(`Event ${eventId} ${hidden ? 'hidden from' : 'returned to'} the site by ${by}`);
    void this.messengersNotifier
      .recheckSales(eventId, hidden ? SALES_REASON.HIDDEN_FROM_SITE : SALES_REASON.SHOWN_ON_SITE)
      .catch((err) => {
        this.logger.warn(`Messenger sales recheck failed for event ${eventId}: ${(err as Error)?.message}`);
      });
    // Same re-crawl ping as a publicly visible save: the page just disappeared or came back.
    if (['ACTIVE', 'COMPLETED', 'CANCELLED'].includes(current.status)) {
      this.indexNowService.notifyPaths([
        this.indexNowService.eventPath(current.id, current.title?.en),
        '/events',
      ]);
    }
    return { id: current.id, hiddenFromSite: hidden, status: current.status };
  }

  /**
   * Organizer cash-payment switch (organizer or their Admin manager): applies at once
   * whatever the status — not a moderation change, the status stays untouched. Idempotent;
   * mirrors `AdminEventsService.setCashPayment`.
   */
  async setCashPayment(
    eventId: number,
    enabled: boolean,
    actor: { userId: string; managerId?: string },
  ): Promise<EventCashPaymentResult> {
    await this.assertOwnedEvent(eventId, actor.userId);
    const current = await this.eventModel
      .findOne({ id: eventId })
      .select({ id: 1, archivedByOrganizer: 1 })
      .lean<{ id: number; archivedByOrganizer?: boolean }>()
      .exec();
    if (!current) {
      throw new NotFoundException('Event not found');
    }
    // An organizer-archived event is frozen like any other edit: restore it first.
    if (current.archivedByOrganizer === true) {
      throw new ConflictException('event_archived');
    }

    // Order matters: a dotted $set into `paymentOptions: null` fails in Mongo, so the
    // object is created first, then a missing thb is filled, then only the flag is set.
    // Each step is conditional and idempotent. No step writes onto an archived event (an
    // archive may land meanwhile); the last one reports it.
    const legacyThb = { ...this.legacyPaymentOptions()!.thb };
    await this.eventModel
      .updateOne(
        { id: eventId, archivedByOrganizer: { $ne: true }, paymentOptions: null },
        { $set: { paymentOptions: { thb: { ...legacyThb }, cashEnabled: enabled } } },
      )
      .exec();
    await this.eventModel
      .updateOne(
        {
          id: eventId,
          archivedByOrganizer: { $ne: true },
          paymentOptions: { $ne: null },
          'paymentOptions.thb': null,
        },
        { $set: { 'paymentOptions.thb': { ...legacyThb } } },
      )
      .exec();
    // The flag only lands on a non-archived event (an archive may land meanwhile).
    const { matchedCount } = await this.eventModel
      .updateOne(
        { id: eventId, archivedByOrganizer: { $ne: true } },
        { $set: { 'paymentOptions.cashEnabled': enabled } },
      )
      .exec();
    if (matchedCount === 0) {
      if (!(await this.eventModel.exists({ id: eventId }).exec())) {
        throw new NotFoundException('Event not found');
      }
      throw new ConflictException('event_archived');
    }

    const by = actor.managerId ? `manager:${actor.managerId}` : `user:${actor.userId}`;
    this.logger.log(
      `Cash payment ${enabled ? 'enabled' : 'disabled'} for event ${eventId} by ${by}`,
    );
    return { id: eventId, cashEnabled: enabled };
  }

  /**
   * The creator of an existing event, for admin mirrors of organizer read paths that
   * take the owner's id (ticket registry, ticket PDF, session orders). 404 when unknown.
   */
  async findEventCreatorId(eventId: number): Promise<string> {
    if (!Number.isSafeInteger(eventId)) {
      throw new NotFoundException('Event not found');
    }
    const event = (await this.eventModel
      .findOne({ id: eventId })
      .select({ creator: 1 })
      .lean()
      .exec()) as Pick<IEvent, 'creator'> | null;
    if (!event) {
      throw new NotFoundException('Event not found');
    }
    return String(event.creator);
  }

  private async assertOwnedEvent(eventId: number, creatorId: string): Promise<void> {
    const event = await this.eventModel
      .findOne({ id: eventId })
      .select({ creator: 1 })
      .lean()
      .exec();
    if (!event) {
      throw new NotFoundException('Event not found');
    }
    if (event.creator !== Number(creatorId)) {
      throw new ForbiddenException('You can only manage your own events');
    }
  }
}
