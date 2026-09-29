import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import mongoose from 'mongoose';
import {
  EventSessionSchema,
  IEventSession,
  type EventSessionStatus,
  type OrganizerSessionStatus,
} from './schemas/event-session.schema';
import {
  EventSchema,
  IEvent,
  ISector,
  type IRecurrence,
} from '../events/schemas/event.schema';
import {
  IMockOrder,
  MockOrderSchema,
  type MockOrderStatus,
} from '../mock-orders/schemas/mock-order.schema';
import { ITicket, TicketSchema } from '../tickets/schemas/ticket.schema';
import { todayIct } from '../events/utils/ict-date.util';
import {
  isSessionSalesClosed,
  salesCutoffMs,
  salesOpenThreshold,
  type SalesCloseBeforeRule,
} from '../events/utils/sales-cutoff.util';
import {
  hasSessionEnded,
  resolveSessionStatusTransition,
  SESSION_STATUS_SOURCES,
} from './utils/session-status.util';
import {
  sessionlessLinesMatch,
  type SessionPeriodFilter,
  type SessionPeriodScope,
} from '../events/utils/session-period-filter.util';

/** Hard ceiling so a typo in the period cannot materialise millions of rows. */
const MAX_GENERATED_SESSIONS = 2000;

/** Order-path refusal for an `active` session past its sales cut-off (or already started). */
export const SESSION_SALES_CLOSED_MESSAGE = 'Ticket sales for this session are closed.';

export type SessionSlot = { date: string; start: string; end: string };

export type SessionZoneAvailability = {
  sectorId: string;
  zoneId: string;
  seats: number;
  reserved: number;
  bought: number;
  remaining: number;
};

export type SessionWithAvailability = {
  id: number;
  date: string;
  start: string;
  end: string;
  status: EventSessionStatus;
  /** Seats still purchasable across every zone of this single session; `0` unless `active`. */
  remainingTickets: number;
  /** Organizer marked it sold out, or an `active` session has no seats left. */
  soldOut: boolean;
  /**
   * Nothing can be bought although the show is neither sold out nor cancelled: an
   * `active` session past its sales cut-off (or already started), or a `disabled` one.
   */
  salesClosed: boolean;
  zones: SessionZoneAvailability[];
};

export type SessionsQueryOptions = {
  /** Organizer view: every status, `disabled` included, past sessions included. */
  includeDisabled?: boolean;
  fromDate?: string;
  /**
   * Storefront calendar: today onwards (ICT) in every status a buyer may see —
   * `active`, `sold_out`, `cancelled` (red), and a flagless (legacy) `disabled` session
   * only while its slot is part of the schedule (closed, never purchasable: `salesClosed`).
   * A slot that left the schedule is never listed unless it is cancelled.
   */
  storefront?: boolean;
  /**
   * Only sessions on sale right now: `active` and before the event's sales cut-off.
   * The one server-side definition every order path shares; per-zone seats are
   * checked by the caller against `zones[].remaining`.
   */
  purchasableOnly?: boolean;
  /** Clock override (tests); defaults to `Date.now()`. */
  now?: number;
};

/** A session as the bulk status action reports it back. */
export type SessionStatusSummary = Pick<IEventSession, 'id' | 'date' | 'start' | 'end' | 'status'>;

export type BulkSessionStatusResult = {
  /** Sessions whose status actually changed (already-in-target ones are skipped). */
  updated: number;
  /** Every requested session after the change, chronological. */
  sessions: SessionStatusSummary[];
  /** Ids of the sessions this call changed (internal: not part of any response). */
  changedIds: number[];
};

/**
 * One show that already has sold tickets, as the organizer edit form and the
 * `session_has_sales` refusal report it.
 */
export type SessionSalesItem = {
  id: number;
  date: string;
  start: string;
  end: string;
  status: EventSessionStatus;
  /** Tickets of paid (not refunded) orders plus active cash bookings for this show. */
  soldTickets: number;
  /** Face price of those tickets (`price × count` of the order lines), THB. */
  soldAmount: number;
  currency: 'THB';
};

/** Response of `GET /events/private/:id/sessions/sales-summary`. */
export type SessionSalesSummary = {
  /** Some show of the event has sold tickets: the show times can no longer change. */
  timesLocked: boolean;
  /** Every show with `soldTickets > 0`, cancelled ones included, chronological. */
  sessions: SessionSalesItem[];
};

/** Per-session sold figures of one event, split the way statistics and the guards read them. */
export type SessionSoldCounters = {
  /** Face-price revenue of `paid` orders — the statistics `revenue`. */
  paidAmount: number;
  /** `paid` plus `pending_cash`: what the schedule guards call "sold". */
  soldTickets: number;
  soldAmount: number;
};

/** What one `healLegacyDisabledSessions` run did (all zero once the data is healed). */
export type LegacyDisabledHealResult = {
  /** Events the flagless `disabled` sessions belong to. */
  events: number;
  /** Sessions back `active`: their slot is in the event's current schedule. */
  reactivated: number;
  /** Sessions left `disabled`, now flagged `disabledBySchedule`: their slot is not scheduled. */
  flagged: number;
  /** Events whose repair threw; their untouched rows are retried on the next boot. */
  failed: number;
};

/**
 * Orders whose tickets count as sold for the schedule guards: a paid order (a completed
 * refund moves it to `refunded`) and a cash booking still waiting at the till — both
 * leave a buyer holding a ticket for that show.
 */
const SOLD_ORDER_STATUSES: readonly MockOrderStatus[] = ['paid', 'pending_cash'];

type ZoneCounters = { reserved: number; bought: number };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` → UTC-midnight Date. Dates are calendar values, never instants. */
function parseIsoDate(value: string): Date {
  if (!ISO_DATE.test(value)) {
    throw new BadRequestException(`Invalid date "${value}", expected YYYY-MM-DD`);
  }
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestException(`Invalid date "${value}"`);
  }
  return date;
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The show times of a recurrence (`sessions`: count, starts, ends) in a canonical form:
 * list order carries no meaning, so a re-sorted but otherwise identical list is no change.
 */
function showTimesSignature(recurrence: Pick<IRecurrence, 'sessions'>): string {
  return JSON.stringify(showTimeKeys(recurrence).sort());
}

/** `start-end` of every show time of a recurrence, in list order. */
function showTimeKeys(recurrence: Pick<IRecurrence, 'sessions'>): string[] {
  return (recurrence.sessions ?? [])
    .filter((time) => time?.start && time?.end)
    .map((time) => showTimeKey(time));
}

function showTimeKey(time: { start: string; end: string }): string {
  return `${time.start}-${time.end}`;
}

/**
 * The show has already taken place: dated before today (ICT), or today and already over.
 * Its buyers were there — taking its slot out of the schedule strands nobody.
 */
function hasSessionTakenPlace(
  session: { date: string; start: string; end: string },
  now: number,
): boolean {
  return session.date < todayIct(now) || hasSessionEnded(session, now);
}

@Injectable()
export class EventSessionsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(EventSessionsService.name);

  /** Idempotent repair of sessions an older schedule sync left without the flag; a no-op once healed. */
  async onApplicationBootstrap(): Promise<void> {
    try {
      await mongoose.connection.asPromise();
      await this.healLegacyDisabledSessions();
    } catch (error) {
      this.logger.error(
        `Legacy disabled sessions heal failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private get sessionModel(): mongoose.Model<IEventSession> {
    return (
      (mongoose.models.EventSession as mongoose.Model<IEventSession>) ??
      mongoose.model<IEventSession>('EventSession', EventSessionSchema)
    );
  }

  private get eventModel(): mongoose.Model<IEvent> {
    return (
      (mongoose.models.Event as mongoose.Model<IEvent>) ??
      mongoose.model<IEvent>('Event', EventSchema)
    );
  }

  private get mockOrderModel(): mongoose.Model<IMockOrder> {
    return (
      (mongoose.models.MockOrder as mongoose.Model<IMockOrder>) ??
      mongoose.model<IMockOrder>('MockOrder', MockOrderSchema)
    );
  }

  private get ticketModel(): mongoose.Model<ITicket> {
    return (
      (mongoose.models.Ticket as mongoose.Model<ITicket>) ??
      mongoose.model<ITicket>('Ticket', TicketSchema)
    );
  }

  private zoneKey(sectorId: string, zoneId: string): string {
    return `${sectorId}::${zoneId}`;
  }

  private slotKey(date: string, start: string): string {
    return `${date}@${start}`;
  }

  /**
   * Expands a recurrence into the concrete slots it describes:
   * every date in `[periodStart, periodEnd]` whose weekday is selected and which is
   * not listed in `exceptions`, crossed with every configured show time.
   */
  generateSessionSlots(recurrence: IRecurrence): SessionSlot[] {
    const start = parseIsoDate(recurrence.periodStart);
    const end = parseIsoDate(recurrence.periodEnd);
    if (end.getTime() < start.getTime()) {
      throw new BadRequestException('recurrence.periodEnd must not be before periodStart');
    }

    const weekdays = new Set((recurrence.weekdays ?? []).map(Number));
    if (!weekdays.size) {
      throw new BadRequestException('recurrence.weekdays must contain at least one day');
    }
    /*
      Two show times with the same start (the organizer clicked "add time" twice
      and left both at the default) would produce two slots per day with the same
      (date, start) — the unique index rejects the second one mid-sync. Refuse it
      here, before anything is written, with a message that names the problem.
    */
    const times = (recurrence.sessions ?? []).filter((s) => s?.start && s?.end);
    if (!times.length) {
      throw new BadRequestException('recurrence.sessions must contain at least one time');
    }
    const seenStarts = new Set<string>();
    for (const time of times) {
      if (seenStarts.has(time.start)) {
        throw new BadRequestException(
          `recurrence.sessions has two show times starting at ${time.start}; each start time must be unique`,
        );
      }
      seenStarts.add(time.start);
    }
    const exceptions = new Set(recurrence.exceptions ?? []);

    const slots: SessionSlot[] = [];
    for (
      let cursor = new Date(start.getTime());
      cursor.getTime() <= end.getTime();
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    ) {
      // getUTCDay(): 0 = Sunday, matching the weekday numbering the client sends.
      if (!weekdays.has(cursor.getUTCDay())) continue;
      const date = toIsoDate(cursor);
      if (exceptions.has(date)) continue;

      for (const time of times) {
        slots.push({ date, start: time.start, end: time.end });
        if (slots.length > MAX_GENERATED_SESSIONS) {
          throw new BadRequestException(
            `Recurrence would generate more than ${MAX_GENERATED_SESSIONS} sessions; shorten the period or reduce show times`,
          );
        }
      }
    }

    if (!slots.length) {
      throw new BadRequestException(
        'Recurrence produces no sessions — check the period, weekdays and exceptions',
      );
    }
    return slots;
  }

  /**
   * `date@start` keys of every slot a recurrence describes. Empty when the recurrence is
   * off or cannot be expanded (a stored legacy schedule must not break a read path).
   */
  private scheduledSlotKeys(recurrence?: IRecurrence | null): Set<string> {
    if (recurrence?.enabled !== true) return new Set();
    try {
      return new Set(
        this.generateSessionSlots(recurrence).map((slot) => this.slotKey(slot.date, slot.start)),
      );
    } catch {
      return new Set();
    }
  }

  /** `scheduledSlotKeys` of the event's stored recurrence (empty when the event is gone). */
  private async loadScheduledSlotKeys(eventId: number): Promise<Set<string>> {
    const event = (await this.eventModel
      .findOne({ id: eventId })
      .select({ recurrence: 1 })
      .lean()
      .exec()) as Pick<IEvent, 'recurrence'> | null;
    return this.scheduledSlotKeys(event?.recurrence);
  }

  /**
   * The one rule for reopening (`active`) a `disabled` show by hand: no schedule flag, its
   * slot in the current schedule (`scheduled`, from `scheduledSlotKeys`) and not in the past
   * (ICT). A show the schedule took away is not a show of the event any more: it returns
   * with its slot, never by hand.
   * Flagless `disabled` rows were only ever written by the schedule sync before the flag
   * existed, and `healLegacyDisabledSessions` flags them at boot (re-activating those back
   * in the schedule), so this matches nothing on healed data; it stays as the safe answer
   * for such a row should one still turn up.
   * `bulkSetStatus` enforces it; `reopenableSessionIds` reports it to the organizer UI.
   */
  private isReopenableDisabledSession(
    session: Pick<IEventSession, 'status' | 'disabledBySchedule' | 'date' | 'start'>,
    scheduled: Set<string>,
    now: number,
  ): boolean {
    return (
      session.status === 'disabled' &&
      session.disabledBySchedule !== true &&
      session.date >= todayIct(now) &&
      scheduled.has(this.slotKey(session.date, session.start))
    );
  }

  /**
   * Ids of the event's `disabled` sessions the organizer may reopen right now — exactly
   * those `bulkSetStatus` would accept `active` for (`isReopenableDisabledSession`).
   * A `sold_out` show reopens through the plain quota toggle and is never listed here.
   */
  async reopenableSessionIds(eventId: number, now: number = Date.now()): Promise<Set<number>> {
    const candidates = (await this.sessionModel
      .find({
        eventId,
        status: 'disabled',
        disabledBySchedule: { $ne: true },
        date: { $gte: todayIct(now) },
      })
      .select({ id: 1, date: 1, start: 1, status: 1, disabledBySchedule: 1 })
      .lean()
      .exec()) as unknown as IEventSession[];
    if (!candidates.length) return new Set();

    const scheduled = await this.loadScheduledSlotKeys(eventId);
    return new Set(
      candidates
        .filter((session) => this.isReopenableDisabledSession(session, scheduled, now))
        .map((session) => session.id),
    );
  }

  /**
   * Materialises `event.recurrence` into `event-sessions`, idempotently.
   *
   * Existing rows are matched on `(eventId, date, start)`, so re-saving an event never
   * duplicates or resets the status of a session (`sold_out`, `cancelled` survive a
   * re-sync). Slots that are no longer part of the schedule are deleted when untouched,
   * and only disabled (never deleted) when they already carry orders, tickets or refund
   * history (`refundedTickets`) — flagged `disabledBySchedule`, so the session comes back
   * when its slot returns: `active`, or
   * `sold_out` when that is what the organizer had set (`scheduleDisabledFrom`).
   * A cancelled one is never deleted and keeps `cancelled`, even once all its orders are
   * refunded; a disabled one without the flag (a legacy row, see
   * `healLegacyDisabledSessions`) keeps its status.
   * One dated before today (ICT) that has orders is left exactly as it is: it already played.
   *
   * Event update paths refuse, before writing, a schedule that would drop a show with sold
   * tickets (`assertScheduleChangeAllowed`); disabling here is the fallback for shows that
   * only carry an in-flight payment, and for callers that bypass that guard.
   */
  async syncSessionsForEvent(eventId: number, recurrence?: IRecurrence | null): Promise<number> {
    if (!recurrence?.enabled) {
      await this.removeSessionsWithoutSales(eventId);
      return 0;
    }

    const slots = this.generateSessionSlots(recurrence);
    const existing = await this.sessionModel.find({ eventId }).lean().exec();
    const existingByKey = new Map(
      existing.map((s) => [this.slotKey(s.date, s.start), s as unknown as IEventSession]),
    );

    const wantedKeys = new Set(slots.map((s) => this.slotKey(s.date, s.start)));
    const toInsert: Array<Partial<IEventSession>> = [];
    const reactivated: number[] = [];

    for (const slot of slots) {
      const key = this.slotKey(slot.date, slot.start);
      const current = existingByKey.get(key);
      if (!current) {
        toInsert.push({ eventId, date: slot.date, start: slot.start, end: slot.end });
        continue;
      }
      // Keep the stored `status` (`sold_out`, `cancelled` are the organizer's); only the end
      // time may drift when times are edited, and a flagged `disabled` row is re-activated.
      const $set: Partial<Pick<IEventSession, 'end' | 'status'>> = {};
      if (current.end !== slot.end) $set.end = slot.end;
      if (current.disabledBySchedule) {
        // The schedule took this slot away and now wants it back: back to what it was.
        if (current.status === 'disabled') {
          $set.status = current.scheduleDisabledFrom === 'sold_out' ? 'sold_out' : 'active';
          reactivated.push(current.id);
        }
        await this.sessionModel
          .updateOne(
            { id: current.id },
            {
              ...(Object.keys($set).length ? { $set } : {}),
              $unset: { disabledBySchedule: 1, scheduleDisabledFrom: 1 },
            },
          )
          .exec();
      } else if (Object.keys($set).length) {
        await this.sessionModel.updateOne({ id: current.id }, { $set }).exec();
      }
    }
    if (reactivated.length) {
      this.logger.log(
        `Event ${eventId}: ${reactivated.length} session(s) back in the schedule re-activated (${reactivated.join(', ')})`,
      );
    }

    if (toInsert.length) {
      // `create` (not insertMany) so the autoinc plugin assigns `id` on each document.
      for (const doc of toInsert) {
        await this.sessionModel.create(doc);
      }
    }

    const orphans = existing.filter((s) => !wantedKeys.has(this.slotKey(s.date, s.start)));
    if (orphans.length) {
      const orphanIds = orphans.map((s) => s.id);
      const withSales = await this.sessionIdsWithSales(eventId, orphanIds);
      const deletable = this.deletableSessionIds(orphans, withSales);
      if (deletable.length) {
        await this.sessionModel.deleteMany({ eventId, id: { $in: deletable } }).exec();
      }
      const keepDisabled = this.sessionIdsFromToday(
        orphans.filter((s) => withSales.has(s.id)),
        Date.now(),
      );
      if (keepDisabled.length) {
        await this.disableDroppedSessions(eventId, keepDisabled);
        this.logger.warn(
          `Event ${eventId}: ${keepDisabled.length} session(s) dropped from the schedule already have orders — kept instead of deleted (disabled unless cancelled)`,
        );
      }
    }

    return slots.length;
  }

  /**
   * Takes sessions that left the schedule off sale, remembering why. A cancelled show stays
   * cancelled (its buyers were told, the scanner declines it); one already `disabled` keeps
   * its status and its flag as they are, so a flagless (legacy) row is never re-opened by a
   * later return of its slot — `healLegacyDisabledSessions` flags those at boot.
   */
  private async disableDroppedSessions(eventId: number, sessionIds: number[]): Promise<void> {
    // The organizer's `sold_out` is remembered, so the returning slot does not re-open sales.
    await this.sessionModel
      .updateMany(
        { eventId, id: { $in: sessionIds }, status: 'sold_out' },
        { $set: { status: 'disabled', disabledBySchedule: true, scheduleDisabledFrom: 'sold_out' } },
      )
      .exec();
    await this.sessionModel
      .updateMany(
        { eventId, id: { $in: sessionIds }, status: 'active' },
        { $set: { status: 'disabled', disabledBySchedule: true } },
      )
      .exec();
  }

  /**
   * Repairs the sessions the schedule sync disabled before it learnt to flag them.
   *
   * Every `disabled` row without `disabledBySchedule` was written by that sync: no organizer
   * or admin client ever set `disabled` (the early single-session PATCH that accepted it had
   * no caller, and the organizer DTOs no longer accept it). Without the flag such a row never
   * came back when its slot returned — a date excluded after a sale and then restored kept
   * its sold shows closed, while its unsold show times were re-created `active`.
   *
   * A row dated today (ICT) or later whose slot is in its event's current schedule is set
   * back `active` — what the sync does for a flagged row whose slot returns. The old sync
   * did not record a `sold_out` it overrode, so such a show comes back `active` too (the
   * organizer can close it again). Any other row (slot not scheduled, already played,
   * schedule off or not expandable, event gone) stays `disabled` and gets the flag, so a
   * later return of its slot re-opens it. Targeted updates only: nothing is deleted or
   * created, no event is re-synced, nothing is cancelled and nobody is notified.
   *
   * Idempotent, and a single indexed query that finds nothing once healed. Every update
   * matches flagless `disabled` rows only, so a run cut short simply leaves the rest for the
   * next boot.
   */
  async healLegacyDisabledSessions(): Promise<LegacyDisabledHealResult> {
    const result: LegacyDisabledHealResult = { events: 0, reactivated: 0, flagged: 0, failed: 0 };
    const legacy = (await this.sessionModel
      .find({ status: 'disabled', disabledBySchedule: { $ne: true } })
      .select({ id: 1, eventId: 1, date: 1, start: 1 })
      .lean()
      .exec()) as unknown as Array<Pick<IEventSession, 'id' | 'eventId' | 'date' | 'start'>>;
    if (!legacy.length) return result;

    const rowsByEvent = new Map<number, typeof legacy>();
    for (const session of legacy) {
      const rows = rowsByEvent.get(session.eventId) ?? [];
      rows.push(session);
      rowsByEvent.set(session.eventId, rows);
    }
    result.events = rowsByEvent.size;

    const legacyFilter = { status: 'disabled', disabledBySchedule: { $ne: true } };
    const today = todayIct(Date.now());
    for (const [eventId, rows] of rowsByEvent) {
      try {
        const event = (await this.eventModel
          .findOne({ id: eventId })
          .select({ recurrence: 1 })
          .lean()
          .exec()) as Pick<IEvent, 'recurrence'> | null;
        // Empty for a missing event or a schedule that is off or does not expand.
        const scheduled = this.scheduledSlotKeys(event?.recurrence);
        const isBack = (row: (typeof rows)[number]) =>
          row.date >= today && scheduled.has(this.slotKey(row.date, row.start));
        const back = rows.filter(isBack);
        const off = rows.filter((row) => !isBack(row));

        if (back.length) {
          const ids = back.map((row) => row.id);
          const res = await this.sessionModel
            .updateMany({ eventId, id: { $in: ids }, ...legacyFilter }, { $set: { status: 'active' } })
            .exec();
          const count = res.modifiedCount ?? 0;
          result.reactivated += count;
          if (count) {
            this.logger.log(
              `Legacy disabled sessions heal: event ${eventId} — ${count} session(s) back in the schedule re-activated (${ids.join(', ')})`,
            );
          }
        }
        if (off.length) {
          const res = await this.sessionModel
            .updateMany(
              { eventId, id: { $in: off.map((row) => row.id) }, ...legacyFilter },
              { $set: { disabledBySchedule: true } },
            )
            .exec();
          result.flagged += res.modifiedCount ?? 0;
        }
      } catch (error) {
        result.failed += 1;
        this.logger.error(
          `Legacy disabled sessions heal: event ${eventId} failed, retried on next boot: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const message = `Legacy disabled sessions heal: ${result.reactivated} session(s) re-activated, ${result.flagged} flagged disabledBySchedule, across ${result.events} event(s), ${result.failed} event(s) failed`;
    if (result.failed) this.logger.warn(message);
    else this.logger.log(message);
    return result;
  }

  /**
   * Ids of the sessions dated today (ICT) or later. A show of an earlier day that leaves the
   * schedule with orders is history — kept exactly as it played (status, sales, statistics),
   * neither deleted nor disabled; the storefront never lists a past day anyway.
   */
  private sessionIdsFromToday(
    sessions: Array<Pick<IEventSession, 'id' | 'date'>>,
    now: number,
  ): number[] {
    const today = todayIct(now);
    return sessions.filter((session) => session.date >= today).map((session) => session.id);
  }

  /**
   * Sessions of this event that already have reservations or issued tickets, or refund
   * history: a completed refund empties `order.tickets` and deletes the tickets, and only
   * the order's `refundedTickets[].session` still points at the show (any order status).
   */
  private async sessionIdsWithSales(eventId: number, sessionIds: number[]): Promise<Set<number>> {
    if (!sessionIds.length) return new Set();
    const [orders, tickets, refundedSessions] = await Promise.all([
      this.mockOrderModel
        .find({
          event: eventId,
          status: { $in: ['wait', 'pending_cash', 'paid'] },
          'tickets.session': { $in: sessionIds },
        })
        .select({ tickets: 1 })
        .lean()
        .exec(),
      this.ticketModel
        .find({ eventId, session: { $in: sessionIds } })
        .select({ session: 1 })
        .lean()
        .exec(),
      this.mockOrderModel
        .distinct('refundedTickets.session', {
          event: eventId,
          'refundedTickets.session': { $in: sessionIds },
        })
        .exec() as Promise<number[]>,
    ]);

    const used = new Set<number>();
    for (const order of orders as Array<Pick<IMockOrder, 'tickets'>>) {
      for (const item of order.tickets ?? []) {
        if (typeof item.session === 'number') used.add(item.session);
      }
    }
    for (const ticket of tickets as Array<Pick<ITicket, 'session'>>) {
      if (typeof ticket.session === 'number') used.add(ticket.session);
    }
    const requested = new Set(sessionIds);
    for (const session of refundedSessions) {
      if (typeof session === 'number' && requested.has(session)) used.add(session);
    }
    return used;
  }

  /**
   * Of the sessions leaving the schedule, the ones that may be deleted outright: no sales
   * or refund history (`withSales`), and never a cancelled one — its buyers were told, and
   * the row is what their orders and refunds keep pointing at.
   */
  private deletableSessionIds(
    sessions: Array<Pick<IEventSession, 'id' | 'status'>>,
    withSales: Set<number>,
  ): number[] {
    return sessions
      .filter((session) => session.status !== 'cancelled' && !withSales.has(session.id))
      .map((session) => session.id);
  }

  private async removeSessionsWithoutSales(eventId: number): Promise<void> {
    const existing = await this.sessionModel
      .find({ eventId })
      .select({ id: 1, date: 1, status: 1 })
      .lean()
      .exec();
    if (!existing.length) return;
    const ids = existing.map((s) => s.id);
    const withSales = await this.sessionIdsWithSales(eventId, ids);
    const deletable = this.deletableSessionIds(existing, withSales);
    if (deletable.length) {
      await this.sessionModel.deleteMany({ eventId, id: { $in: deletable } }).exec();
    }
    const keep = this.sessionIdsFromToday(
      existing.filter((s) => withSales.has(s.id)),
      Date.now(),
    );
    if (keep.length) {
      await this.disableDroppedSessions(eventId, keep);
    }
  }

  /**
   * Sold tickets per session of one event, from the order lines: `paid` orders (the same
   * `price × count` aggregation the organizer statistics report as a show's revenue) and
   * active cash bookings. Sessions without such lines are absent from the map.
   */
  async soldCountersBySession(eventId: number): Promise<Map<number, SessionSoldCounters>> {
    const rows = await this.mockOrderModel
      .aggregate<{ _id: { session: number; status: MockOrderStatus }; tickets: number; amount: number }>([
        { $match: { event: eventId, status: { $in: [...SOLD_ORDER_STATUSES] } } },
        { $unwind: '$tickets' },
        { $match: { 'tickets.session': { $ne: null } } },
        {
          $group: {
            _id: { session: '$tickets.session', status: '$status' },
            tickets: { $sum: '$tickets.count' },
            amount: { $sum: { $multiply: ['$tickets.price', '$tickets.count'] } },
          },
        },
      ])
      .exec();

    const bySession = new Map<number, SessionSoldCounters>();
    for (const row of rows) {
      const counters = bySession.get(row._id.session) ?? {
        paidAmount: 0,
        soldTickets: 0,
        soldAmount: 0,
      };
      if (row._id.status === 'paid') counters.paidAmount += row.amount ?? 0;
      counters.soldTickets += row.tickets ?? 0;
      counters.soldAmount += row.amount ?? 0;
      bySession.set(row._id.session, counters);
    }
    return bySession;
  }

  /** Sessions of the event that have sold tickets, chronological, with their stored flags. */
  private async loadSoldSessions(
    eventId: number,
  ): Promise<Array<{ session: IEventSession; item: SessionSalesItem }>> {
    const counters = await this.soldCountersBySession(eventId);
    const soldIds = [...counters.entries()]
      .filter(([, sold]) => sold.soldTickets > 0)
      .map(([id]) => id);
    if (!soldIds.length) return [];

    const sessions = (await this.sessionModel
      .find({ eventId, id: { $in: soldIds } })
      .select({ id: 1, date: 1, start: 1, end: 1, status: 1, disabledBySchedule: 1 })
      .sort({ date: 1, start: 1 })
      .lean()
      .exec()) as unknown as IEventSession[];
    return sessions.map((session) => {
      const sold = counters.get(session.id)!;
      return {
        session,
        item: {
          id: session.id,
          date: session.date,
          start: session.start,
          end: session.end,
          status: session.status,
          soldTickets: sold.soldTickets,
          soldAmount: Math.round(sold.soldAmount * 100) / 100,
          currency: 'THB',
        },
      };
    });
  }

  /** What the organizer edit form needs to know before it lets the schedule change. */
  async getSalesSummary(eventId: number): Promise<SessionSalesSummary> {
    const sold = await this.loadSoldSessions(eventId);
    return { timesLocked: sold.length > 0, sessions: sold.map(({ item }) => item) };
  }

  /**
   * Refuses a schedule change that would strand buyers. Call it BEFORE anything of the
   * update is written (event document, moderation status, sessions, notifications):
   *  - once any show of the event has sold tickets, the show times (`recurrence.sessions`:
   *    count, starts, ends) are fixed — 409 `recurrence_times_locked`;
   *  - a new schedule that drops a non-cancelled show with sold tickets from the current
   *    schedule (exception date, removed weekday, shorter period, recurrence switched off)
   *    — 409 `session_has_sales` listing those shows. Such a show can only be cancelled.
   * Shows without sold tickets may go; `syncSessionsForEvent` removes them as usual. So may
   * a show that has already taken place (an earlier day, or today and over): its buyers
   * were there, and it could not be cancelled any more anyway.
   * `current` / `next` are the stored and the submitted recurrence (`enabled: false` or
   * absent = no schedule).
   */
  async assertScheduleChangeAllowed(
    eventId: number,
    current: IRecurrence | null | undefined,
    next: IRecurrence | null | undefined,
    now: number = Date.now(),
  ): Promise<void> {
    const sold = await this.loadSoldSessions(eventId);
    if (!sold.length) return;

    const currentSchedule = current?.enabled === true ? current : null;
    const nextSchedule = next?.enabled === true ? next : null;
    if (currentSchedule && nextSchedule) {
      if (showTimesSignature(currentSchedule) !== showTimesSignature(nextSchedule)) {
        throw new ConflictException('recurrence_times_locked');
      }
    } else if (nextSchedule) {
      /*
        No stored schedule to compare with — the event was switched to one-off after its
        first sale. The times its sold shows ran at are the ones still known: each must stay
        a show time of the new schedule, or switching off and back on would unlock them.
      */
      const nextTimes = new Set(showTimeKeys(nextSchedule));
      if (sold.some(({ session }) => !nextTimes.has(showTimeKey(session)))) {
        throw new ConflictException('recurrence_times_locked');
      }
    }

    const currentKeys = this.scheduledSlotKeys(currentSchedule);
    const nextKeys = nextSchedule
      ? new Set(
          this.generateSessionSlots(nextSchedule).map((slot) => this.slotKey(slot.date, slot.start)),
        )
      : new Set<string>();
    /*
      Dropped = what the sync would take away from buyers: a show on sale or sold out
      whose slot is not in the new schedule (it would be disabled), or a flagless (legacy,
      see `healLegacyDisabledSessions`) closed show still listed on the storefront because
      its slot is in the current schedule (it would vanish). A show the schedule already
      took away earlier is not dropped again, and one that has already taken place strands
      nobody.
    */
    const dropped = sold.filter(({ session }) => {
      if (hasSessionTakenPlace(session, now)) return false;
      const key = this.slotKey(session.date, session.start);
      if (nextKeys.has(key)) return false;
      if (session.status === 'active' || session.status === 'sold_out') return true;
      return session.status === 'disabled' && !session.disabledBySchedule && currentKeys.has(key);
    });
    if (dropped.length) {
      throw new ConflictException({
        statusCode: 409,
        message: 'session_has_sales',
        sessions: dropped.map(({ item }) => item),
      });
    }
  }

  /**
   * For a regular event: the busiest single session's `bought` count per zone,
   * keyed `sectorId::zoneId`. This — not the event-wide total — is what a zone's
   * per-show `seats` must stay above when the organizer edits the structure:
   * seats are per session, so summing tickets across a month of shows would lock
   * every successful run out of editing after its first sell-out-worth of sales.
   */
  async maxBoughtPerSessionByZone(eventId: number): Promise<Map<string, number>> {
    const bySession = await this.buildSessionZoneCounters(eventId);
    const max = new Map<string, number>();
    for (const zones of bySession.values()) {
      for (const [key, counters] of zones) {
        if (counters.bought > (max.get(key) ?? 0)) max.set(key, counters.bought);
      }
    }
    return max;
  }

  /** Reserved + bought counters per `(sessionId, sectorId::zoneId)` for one event. */
  private async buildSessionZoneCounters(
    eventId: number,
  ): Promise<Map<number, Map<string, ZoneCounters>>> {
    const bySession = new Map<number, Map<string, ZoneCounters>>();
    const bump = (sessionId: number, key: string, field: keyof ZoneCounters, by: number) => {
      let zones = bySession.get(sessionId);
      if (!zones) {
        zones = new Map<string, ZoneCounters>();
        bySession.set(sessionId, zones);
      }
      const counters = zones.get(key) ?? { reserved: 0, bought: 0 };
      counters[field] += by;
      zones.set(key, counters);
    };

    const [reservedOrders, boughtTickets] = await Promise.all([
      this.mockOrderModel
        .find({ event: eventId, status: { $in: ['wait', 'pending_cash'] } })
        .select({ tickets: 1 })
        .lean()
        .exec(),
      this.ticketModel
        .find({ eventId })
        .select({ sector: 1, zone: 1, session: 1 })
        .lean()
        .exec(),
    ]);

    for (const order of reservedOrders as Array<Pick<IMockOrder, 'tickets'>>) {
      for (const item of order.tickets ?? []) {
        if (typeof item.session !== 'number') continue;
        bump(item.session, this.zoneKey(item.sectorId, item.zoneId), 'reserved', item.count ?? 0);
      }
    }
    for (const ticket of boughtTickets as Array<Pick<ITicket, 'sector' | 'zone' | 'session'>>) {
      if (typeof ticket.session !== 'number') continue;
      bump(ticket.session, this.zoneKey(ticket.sector, ticket.zone), 'bought', 1);
    }

    return bySession;
  }

  /**
   * Session filter for "still on sale right now" under an event's cut-off rule:
   * strictly after `now + cutoff` (ICT). Same answer as `!isSessionSalesClosed`, so
   * a session that has already started today is never on sale either.
   */
  private onSaleFilter(
    rule: SalesCloseBeforeRule,
    now: number,
  ): mongoose.FilterQuery<IEventSession> {
    const threshold = salesOpenThreshold(rule, now);
    return {
      $or: [
        { date: { $gt: threshold.date } },
        { date: threshold.date, start: { $gt: threshold.clock } },
      ],
    };
  }

  /**
   * Sessions of an event with per-zone availability. Each session sells the event's
   * zone capacity independently, so a seat sold for the 6th does not reduce the 11th.
   *
   * Only an `active` session offers seats: `sold_out`, `cancelled` and `disabled`
   * ones report `remaining: 0` everywhere while keeping their real `bought`/`reserved`.
   */
  async getSessionsWithAvailability(
    eventId: number,
    options: SessionsQueryOptions = {},
  ): Promise<SessionWithAvailability[]> {
    const event = (await this.eventModel.findOne({ id: eventId }).lean().exec()) as IEvent | null;
    if (!event) {
      throw new NotFoundException('Event not found');
    }
    const now = options.now ?? Date.now();

    /*
      `purchasableOnly` is the one definition of "can be bought now" shared by card,
      promo100 and cash checkout (and the cash restore path): an `active` session
      before its sales cut-off. Dates are ICT wall-clock strings, so "today" and
      "already started" are judged in ICT, never on the UTC day.
    */
    const conditions: Array<mongoose.FilterQuery<IEventSession>> = [{ eventId }];
    if (options.purchasableOnly) {
      conditions.push({ status: 'active' }, this.onSaleFilter(event.salesCloseBefore, now));
    } else if (options.storefront) {
      conditions.push(
        { status: { $in: ['active', 'sold_out', 'cancelled', 'disabled'] } },
        { date: { $gte: todayIct(now) } },
      );
    } else if (!options.includeDisabled) {
      conditions.push({ status: 'active' });
    }
    if (options.fromDate) conditions.push({ date: { $gte: options.fromDate } });
    const query = conditions.length === 1 ? conditions[0] : { $and: conditions };

    const [found, countersBySession] = await Promise.all([
      this.sessionModel.find(query).sort({ date: 1, start: 1 }).lean().exec(),
      this.buildSessionZoneCounters(eventId),
    ]);

    let sessions = found as unknown as IEventSession[];
    if (options.storefront && sessions.some((session) => session.status === 'disabled')) {
      /*
        A flagless (legacy) closed show is listed only while its slot belongs to the
        schedule, so every date offers the same show times; `healLegacyDisabledSessions`
        leaves none of those on healed data. One the schedule itself took away is not a
        show time of that date any more (and comes back `active` if the slot returns).
      */
      const scheduled = this.scheduledSlotKeys(event.recurrence);
      sessions = sessions.filter(
        (session) =>
          session.status !== 'disabled' ||
          (!session.disabledBySchedule && scheduled.has(this.slotKey(session.date, session.start))),
      );
    }

    return sessions.map((session) => {
      const counters = countersBySession.get(session.id);
      const isActive = session.status === 'active';
      const zones: SessionZoneAvailability[] = [];
      let remainingTickets = 0;

      for (const sector of (event.sectors ?? []) as ISector[]) {
        for (const zone of sector.zones ?? []) {
          const c = counters?.get(this.zoneKey(sector.id, zone.id));
          const reserved = c?.reserved ?? 0;
          const bought = c?.bought ?? 0;
          const remaining = isActive ? Math.max((zone.seats ?? 0) - reserved - bought, 0) : 0;
          remainingTickets += remaining;
          zones.push({
            sectorId: sector.id,
            zoneId: zone.id,
            seats: zone.seats ?? 0,
            reserved,
            bought,
            remaining,
          });
        }
      }

      return {
        id: session.id,
        date: session.date,
        start: session.start,
        end: session.end,
        status: session.status,
        remainingTickets,
        soldOut: session.status === 'sold_out' || (isActive && remainingTickets === 0),
        salesClosed:
          session.status === 'disabled' ||
          (isActive && isSessionSalesClosed(session, event.salesCloseBefore, now)),
        zones,
      };
    });
  }

  /**
   * Seats a regular event still offers, per zone (`sectorId::zoneId`): summed over its
   * sessions on sale right now — `active` and before the event's own sales cut-off, the
   * `purchasableOnly` rule — each as `max(seats − reserved − bought, 0)`, exactly what the
   * per-session feed shows. The list-level figure behind the cards' "seats remaining" and
   * `soldOut`: a show that is over, closed, sold out or cancelled neither adds seats nor
   * has its tickets subtracted from the shows still being sold. An event with no session
   * on sale is absent from the map (nothing left).
   */
  async getOnSaleZoneRemaining(
    events: Array<Pick<IEvent, 'id' | 'salesCloseBefore' | 'sectors'>>,
    now: number = Date.now(),
  ): Promise<Map<number, Map<string, number>>> {
    const remainingByEvent = new Map<number, Map<string, number>>();
    if (!events.length) return remainingByEvent;
    // One `$or` branch per distinct cut-off, not per event: most events share "none".
    const byCutoff = new Map<number, { rule: SalesCloseBeforeRule; ids: number[] }>();
    for (const event of events) {
      const cutoff = salesCutoffMs(event.salesCloseBefore);
      const bucket = byCutoff.get(cutoff) ?? { rule: event.salesCloseBefore, ids: [] };
      bucket.ids.push(event.id);
      byCutoff.set(cutoff, bucket);
    }
    const sessions = (await this.sessionModel
      .find({
        status: 'active',
        $or: [...byCutoff.values()].map(({ rule, ids }) => ({
          eventId: { $in: ids },
          ...this.onSaleFilter(rule, now),
        })),
      })
      .select({ id: 1, eventId: 1 })
      .lean()
      .exec()) as unknown as Array<Pick<IEventSession, 'id' | 'eventId'>>;
    if (!sessions.length) return remainingByEvent;

    const sessionIds = sessions.map((session) => session.id);
    const eventIds = [...new Set(sessions.map((session) => session.eventId))];
    type TakenRow = { _id: { session: number; sector: string; zone: string }; count: number };
    // Same counters as `buildSessionZoneCounters`, restricted to the sessions on sale.
    const [reservedRows, boughtRows] = await Promise.all([
      this.mockOrderModel.aggregate<TakenRow>([
        {
          $match: {
            event: { $in: eventIds },
            status: { $in: ['wait', 'pending_cash'] },
            'tickets.session': { $in: sessionIds },
          },
        },
        { $unwind: '$tickets' },
        { $match: { 'tickets.session': { $in: sessionIds } } },
        {
          $group: {
            _id: { session: '$tickets.session', sector: '$tickets.sectorId', zone: '$tickets.zoneId' },
            count: { $sum: '$tickets.count' },
          },
        },
      ]),
      this.ticketModel.aggregate<TakenRow>([
        { $match: { eventId: { $in: eventIds }, session: { $in: sessionIds } } },
        {
          $group: {
            _id: { session: '$session', sector: '$sector', zone: '$zone' },
            count: { $sum: 1 },
          },
        },
      ]),
    ]);
    const taken = new Map<string, number>();
    for (const row of [...reservedRows, ...boughtRows]) {
      const key = `${row._id.session}@${this.zoneKey(row._id.sector, row._id.zone)}`;
      taken.set(key, (taken.get(key) ?? 0) + (row.count ?? 0));
    }

    const eventById = new Map(events.map((event) => [event.id, event]));
    for (const session of sessions) {
      const event = eventById.get(session.eventId);
      if (!event) continue;
      const zones = remainingByEvent.get(event.id) ?? new Map<string, number>();
      for (const sector of (event.sectors ?? []) as ISector[]) {
        for (const zone of sector.zones ?? []) {
          const key = this.zoneKey(sector.id, zone.id);
          const left = Math.max((zone.seats ?? 0) - (taken.get(`${session.id}@${key}`) ?? 0), 0);
          zones.set(key, (zones.get(key) ?? 0) + left);
        }
      }
      remainingByEvent.set(event.id, zones);
    }
    return remainingByEvent;
  }

  async findSession(eventId: number, sessionId: number): Promise<IEventSession | null> {
    return this.sessionModel.findOne({ eventId, id: sessionId }).lean().exec() as Promise<
      IEventSession | null
    >;
  }

  /**
   * The 400 an order path raises for a requested session that is not in the
   * `purchasableOnly` list. A session that exists but is off sale gets a specific
   * reason the storefront can explain; anything else (unknown id, another event's
   * session, `disabled`) keeps the caller's own historical message.
   */
  async sessionUnavailableError(
    eventId: number,
    sessionId: number | undefined,
    fallbackMessage: string,
    now: number = Date.now(),
  ): Promise<BadRequestException> {
    if (typeof sessionId !== 'number') return new BadRequestException(fallbackMessage);
    const [session, event] = await Promise.all([
      this.sessionModel
        .findOne({ eventId, id: sessionId })
        .select({ date: 1, start: 1, status: 1 })
        .lean()
        .exec(),
      this.eventModel.findOne({ id: eventId }).select({ salesCloseBefore: 1 }).lean().exec(),
    ]);
    if (session?.status === 'cancelled') return new BadRequestException('session_cancelled');
    if (session?.status === 'sold_out') return new BadRequestException('session_sold_out');
    if (
      session?.status === 'active' &&
      isSessionSalesClosed(session, event?.salesCloseBefore, now)
    ) {
      return new BadRequestException(SESSION_SALES_CLOSED_MESSAGE);
    }
    return new BadRequestException(fallbackMessage);
  }

  /**
   * Which shows of an event a statistics period covers: sessions dated inside
   * `[from, to]` (ICT, inclusive) and/or the one requested, in EVERY status — cancelled
   * and disabled shows sold real tickets — plus whether session-less lines (a one-off
   * event, dated by its `eventDate.startDate`) fall inside the period.
   */
  async resolvePeriodScope(
    event: Pick<IEvent, 'id' | 'eventDate'>,
    filter: SessionPeriodFilter,
  ): Promise<SessionPeriodScope> {
    const query: mongoose.FilterQuery<IEventSession> = { eventId: event.id };
    if (filter.sessionId !== undefined) query.id = filter.sessionId;
    if (filter.from || filter.to) {
      query.date = {
        ...(filter.from ? { $gte: filter.from } : {}),
        ...(filter.to ? { $lte: filter.to } : {}),
      };
    }
    const sessions = (await this.sessionModel
      .find(query)
      .select({ id: 1, date: 1, start: 1, end: 1, status: 1 })
      .sort({ date: 1, start: 1 })
      .lean()
      .exec()) as unknown as IEventSession[];
    return {
      sessions: sessions.map(({ id, date, start, end, status }) => ({ id, date, start, end, status })),
      sessionIds: sessions.map((session) => session.id),
      sessionlessMatch: sessionlessLinesMatch(event.eventDate?.startDate, filter),
    };
  }

  /** Ids of this event's sessions the organizer has cancelled. */
  async cancelledSessionIds(eventId: number): Promise<number[]> {
    return this.sessionModel.distinct('id', { eventId, status: 'cancelled' }).exec() as Promise<
      number[]
    >;
  }

  /** Ids among these sessions of the event that are off sale (`disabled`). */
  async disabledSessionIds(eventId: number, sessionIds: number[]): Promise<number[]> {
    if (!sessionIds.length) return [];
    return this.sessionModel
      .distinct('id', { eventId, id: { $in: sessionIds }, status: 'disabled' })
      .exec() as Promise<number[]>;
  }

  /** True when any of these sessions of the event has been cancelled by the organizer. */
  async hasCancelledSession(eventId: number, sessionIds: number[]): Promise<boolean> {
    if (!sessionIds.length) return false;
    const found = await this.sessionModel
      .exists({ eventId, id: { $in: sessionIds }, status: 'cancelled' })
      .exec();
    return Boolean(found);
  }

  /**
   * Organizer status action on one or many sessions of an event (sell out, reopen,
   * cancel). Validation is all-or-nothing — one bad id rejects the whole request
   * before anything is written:
   *   - every id must be a session of this event (404 `session_not_found`);
   *   - no session may lie in the past, ICT (400 `session_in_past`), and a show that has
   *     already ended today cannot be cancelled either (same 400);
   *   - `cancelled` is terminal (400 `session_cancelled`), `disabled` belongs to the
   *     system (400 `invalid_status_transition`) — except cancelling it (flagged or not: a
   *     payment may have completed after the schedule took the show away, and its buyers
   *     are owed the letter) and reopening a flagless (legacy) disabled show whose slot is
   *     in the schedule — none is left once `healLegacyDisabledSessions` has run.
   * A session already in the target status is skipped. Each write is conditional on
   * the source status it was validated in, so a concurrent change can never turn a
   * cancelled show back on. The buyers of cancelled shows are e-mailed by the caller
   * (SessionCancellationNotifier), which tracks who has been told.
   */
  async bulkSetStatus(
    eventId: number,
    sessionIds: number[],
    status: OrganizerSessionStatus,
    now: number = Date.now(),
  ): Promise<BulkSessionStatusResult> {
    const ids = [...new Set(sessionIds)];
    const found = (await this.sessionModel
      .find({ eventId, id: { $in: ids } })
      .lean()
      .exec()) as unknown as IEventSession[];
    const byId = new Map(found.map((session) => [session.id, session]));
    if (ids.some((id) => !byId.has(id))) {
      throw new NotFoundException('session_not_found');
    }
    const today = todayIct(now);
    if (found.some((session) => session.date < today)) {
      throw new BadRequestException('session_in_past');
    }
    /*
      An earlier show of today that is already over took place: cancelling it would tell
      the people who were there that their tickets are void. A show still running stays
      cancellable (the storm hits mid-show); an already-cancelled one is just skipped.
    */
    if (
      status === 'cancelled' &&
      found.some((session) => session.status !== 'cancelled' && hasSessionEnded(session, now))
    ) {
      throw new BadRequestException('session_in_past');
    }

    const toChange: number[] = [];
    let scheduled: Set<string> | undefined;
    for (const id of ids) {
      const session = byId.get(id)!;
      const verdict = resolveSessionStatusTransition(session.status, status);
      if (verdict === 'skip') continue;
      if (verdict !== 'change') throw new BadRequestException(verdict);
      /*
        Reopening a `disabled` show is allowed only under `isReopenableDisabledSession`
        (flagless legacy row, slot in the schedule). Cancelling one needs no such condition.
      */
      if (session.status === 'disabled' && status !== 'cancelled') {
        scheduled ??= await this.loadScheduledSlotKeys(eventId);
        if (!this.isReopenableDisabledSession(session, scheduled, now)) {
          throw new BadRequestException('invalid_status_transition');
        }
      }
      toChange.push(id);
    }

    const changed: number[] = [];
    for (const id of toChange) {
      /*
        Cancelling is final whatever took the show off sale, and the row stops being the
        schedule's (no flag left to re-activate it). Any other target never touches a row
        the schedule took away.
      */
      const result = await this.sessionModel
        .updateOne(
          {
            eventId,
            id,
            status: { $in: [...SESSION_STATUS_SOURCES[status]] },
            ...(status === 'cancelled' ? {} : { disabledBySchedule: { $ne: true } }),
          },
          status === 'cancelled'
            ? { $set: { status }, $unset: { disabledBySchedule: 1, scheduleDisabledFrom: 1 } }
            : { $set: { status } },
        )
        .exec();
      if (result.modifiedCount) changed.push(id);
    }
    if (changed.length) {
      this.logger.log(
        `Event ${eventId}: ${changed.length} session(s) set to ${status} (${changed.join(', ')})`,
      );
    }

    const after = (await this.sessionModel
      .find({ eventId, id: { $in: ids } })
      .select({ id: 1, date: 1, start: 1, end: 1, status: 1 })
      .sort({ date: 1, start: 1 })
      .lean()
      .exec()) as unknown as IEventSession[];

    return {
      updated: changed.length,
      sessions: after.map(({ id, date, start, end, status: current }) => ({
        id,
        date,
        start,
        end,
        status: current,
      })),
      changedIds: changed,
    };
  }

  async deleteAllForEvent(eventId: number): Promise<void> {
    await this.sessionModel.deleteMany({ eventId }).exec();
  }
}
