import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Cron } from '@nestjs/schedule';
import type { EventSessionsService } from '../../event-sessions/event-sessions.service';
import type { IEventSession } from '../../event-sessions/schemas/event-session.schema';
import type { EventsService } from '../../events/events.service';
import { todayIct } from '../../events/utils/ict-date.util';
import type { IEvent } from '../../events/schemas/event.schema';
import type { IMockOrder } from '../../mock-orders/schemas/mock-order.schema';
import {
  ARBIPAY_PENDING_ORDER_TTL_MS,
  PENDING_ORDER_TTL_MS,
} from '../../mock-orders/utils/pending-order-expiry.util';
import type { IReview } from '../../reviews/schemas/review.schema';
import type { ITicket } from '../../tickets/schemas/ticket.schema';
import type { ICustomer } from '../../customers/schemas/customer.schema';
import { type EventMessengerTriggerKey } from '../constants/event-messengers.constants';
import { messengerSendBlockedReason } from '../utils/event-messenger-deliveries.util';
import { describeMessengerError } from '../line/line-api.client';
import {
  eventMessengerDeliveryModel,
  eventMessengerIntegrationModel,
  messengerCustomerModel,
  messengerEventModel,
  messengerEventSessionModel,
  messengerMockOrderModel,
  messengerReviewModel,
  messengerTicketModel,
  type LeanEventMessengerIntegration,
} from '../schemas/event-messenger.models';
import {
  buildOrderPaidMessage,
  buildReviewCreatedMessage,
  buildSalesChangedMessage,
  buildSessionsCancelledMessage,
} from '../utils/event-messenger-messages.util';
import {
  evaluateSalesAvailability,
  evaluateSalesGate,
  maySoldOutBeCheckoutHolds,
  resolveSalesReason,
  type SalesState,
} from '../utils/event-sales-state.util';
import { EventMessengerDeliveryService, type DeliveryOutcome } from './event-messenger-delivery.service';

export type SalesRecheckResult =
  | { status: 'no_integration' }
  | { status: 'event_not_found' }
  /** Same state as last time: nothing to say. */
  | { status: 'unchanged'; open: boolean }
  /** First computation for this integration: stored without a message. */
  | { status: 'baseline'; open: boolean }
  /** "Sold out" while unpaid online checkouts hold seats: the stored state is left alone. */
  | { status: 'deferred'; reason: string }
  /** An edge. `delivery` is `null` when the integration may not send (disabled, no group, trigger off). */
  | { status: 'changed'; open: boolean; reason: string; delivery: DeliveryOutcome | null };

const SESSION_CANCELLED_KEY_PREFIX = 'session-cancelled:';
/** An unpaid online order older than every payment window no longer counts as a checkout in progress. */
const CHECKOUT_HOLD_MAX_MS = Math.max(PENDING_ORDER_TTL_MS, ARBIPAY_PENDING_ORDER_TTL_MS);

/**
 * Trigger side of per-event messenger notifications. Every public method is meant to be
 * called fire-and-forget from the flow that caused it (`void notifier.x(...).catch(log)`):
 * it re-reads what it needs, skips silently when the event has no enabled integration
 * with a connected group and the trigger on, and never touches the caller's data.
 *
 * Availability for the sales edges comes from EventsService / EventSessionsService,
 * resolved lazily through ModuleRef: those modules import this one to call the hooks,
 * so neither a module import nor a file-level import of their services is possible here.
 */
@Injectable()
export class EventMessengersNotifierService {
  private readonly logger = new Logger(EventMessengersNotifierService.name);
  private sweepRunning = false;
  /** Serialises the sales recheck per event inside this process (hook + cron racing). */
  private readonly salesChains = new Map<number, Promise<unknown>>();

  constructor(
    private readonly moduleRef: ModuleRef,
    private readonly delivery: EventMessengerDeliveryService,
  ) {}

  /* ------------------------------------------------------------------ T1 order paid */

  /**
   * "New ticket sale" for a paid order (dedup `order:<id>`), then the sales recheck so a
   * sale that took the last seat closes sales. A non-paid or unknown order is ignored.
   */
  async notifyOrderPaid(orderId: number): Promise<void> {
    const order = (await messengerMockOrderModel().findOne({ id: orderId }).lean().exec()) as IMockOrder | null;
    if (!order || order.status !== 'paid') return;
    const integration = await this.findLineIntegration(order.event);
    if (!integration) return;
    try {
      if (!this.canSend(integration, 'orderPaid')) return;
      const [event, customer, tickets] = await Promise.all([
        messengerEventModel().findOne({ id: order.event }).lean().exec() as Promise<IEvent | null>,
        messengerCustomerModel()
          .findOne({ id: order.customer })
          .select({ fullname: 1, email: 1, phone: 1 })
          .lean()
          .exec() as Promise<Pick<ICustomer, 'fullname' | 'email' | 'phone'> | null>,
        messengerTicketModel()
          .find({ orderId: order.id })
          .select({ id: 1, code: 1 })
          .sort({ id: 1 })
          .lean()
          .exec() as Promise<Array<Pick<ITicket, 'code'>>>,
      ]);
      if (!event) return;
      const text = buildOrderPaidMessage({
        order,
        event,
        buyer: customer,
        ticketCodes: tickets.map((ticket) => ticket.code),
      });
      await this.delivery.deliver(integration, 'order_paid', `order:${order.id}`, text);
    } finally {
      await this.recheckSales(order.event);
    }
  }

  /* ------------------------------------------------------------ T2 session cancelled */

  /**
   * "Show cancelled" listing the sessions that changed to `cancelled`. Only sessions of
   * this event whose stored status is `cancelled` are listed, and sessions already
   * announced (an earlier `session-cancelled:` delivery names them) are left out; the
   * dedup key is `session-cancelled:<ids sorted, comma-joined>`. `affectedPaidOrders` is
   * used when every requested id is listed, otherwise (and when omitted) it is the count
   * of paid orders holding a line on the listed sessions.
   */
  async notifySessionsCancelled(eventId: number, sessionIds: number[], affectedPaidOrders?: number): Promise<void> {
    const requested = [...new Set((sessionIds ?? []).filter((id) => Number.isInteger(id)))].sort((a, b) => a - b);
    if (!requested.length) return;
    const integration = await this.findLineIntegration(eventId);
    if (!integration || !this.canSend(integration, 'sessionCancelled')) return;

    const announced = new Set<number>();
    const previous = (await eventMessengerDeliveryModel()
      .find({ eventId, provider: 'line', kind: 'session_cancelled' })
      .select({ dedupKey: 1 })
      .lean()
      .exec()) as Array<{ dedupKey: string }>;
    for (const { dedupKey } of previous) {
      if (!dedupKey.startsWith(SESSION_CANCELLED_KEY_PREFIX)) continue;
      for (const part of dedupKey.slice(SESSION_CANCELLED_KEY_PREFIX.length).split(',')) {
        const id = Number(part);
        if (Number.isInteger(id)) announced.add(id);
      }
    }
    const unannounced = requested.filter((id) => !announced.has(id));
    if (!unannounced.length) return;
    // Only sessions of this event that really are cancelled now.
    const sessions = (await messengerEventSessionModel()
      .find({ eventId, id: { $in: unannounced }, status: 'cancelled' })
      .select({ id: 1, date: 1, start: 1 })
      .sort({ date: 1, start: 1, id: 1 })
      .lean()
      .exec()) as Array<Pick<IEventSession, 'id' | 'date' | 'start'>>;
    if (!sessions.length) return;
    const fresh = sessions.map((session) => session.id).sort((a, b) => a - b);

    const [event, counted] = await Promise.all([
      messengerEventModel().findOne({ id: eventId }).select({ id: 1, title: 1 }).lean().exec() as Promise<Pick<IEvent, 'id' | 'title'> | null>,
      affectedPaidOrders !== undefined && fresh.length === requested.length
        ? Promise.resolve(affectedPaidOrders)
        : messengerMockOrderModel()
            .countDocuments({ event: eventId, status: 'paid', 'tickets.session': { $in: fresh } })
            .exec(),
    ]);
    const text = buildSessionsCancelledMessage({
      event: event ?? { id: eventId },
      sessions,
      affectedPaidOrders: counted,
    });
    await this.delivery.deliver(integration, 'session_cancelled', `${SESSION_CANCELLED_KEY_PREFIX}${fresh.join(',')}`, text);
  }

  /* --------------------------------------------------------- T3/T4 sales closed/opened */

  /**
   * Recomputes the event-level sales state and reports an edge. The stored `salesOpen`
   * flips with an atomic conditional update (`salesOpen: {$ne: next}`), so only the call
   * that changed it sends. A `null` baseline is set silently. The state is kept current
   * even when the integration may not send (disabled, no group, trigger off). A "sold out"
   * that unpaid checkouts may undo waits for them (`isHeldByCheckouts`).
   */
  recheckSales(eventId: number, reason?: string): Promise<SalesRecheckResult> {
    return this.serialiseSales(eventId, () => this.recheckSalesNow(eventId, reason));
  }

  /**
   * Stores the current sales state without sending anything (create, re-enable, group
   * connected). A "sold out" held by unpaid checkouts is stored as open: if they are paid, the
   * close is announced then; if they are abandoned, nothing changed.
   */
  refreshSalesBaseline(eventId: number): Promise<boolean | null> {
    return this.serialiseSales(eventId, async () => {
      const state = await this.computeSalesState(eventId);
      if (!state) return null;
      const open = state.open || (await this.isHeldByCheckouts(eventId, state));
      await eventMessengerIntegrationModel()
        .updateOne({ eventId, provider: 'line' }, { $set: { salesOpen: open } }, { timestamps: false })
        .exec();
      return open;
    });
  }

  /**
   * `open` = `status === 'ACTIVE'` && not hidden/archived (`isHiddenFromSite`) && not past
   * a one-off event's sales cut-off (`isEventSalesEnded`) && seats: a regular event needs
   * a session from `EventSessionsService.getSessionsWithAvailability(eventId,
   * { purchasableOnly: true })` with `remainingTickets > 0`; a one-off event needs
   * `EventsService.getAvailableTicketsCountByEventIds([eventId])` > 0. `null` when the
   * event does not exist.
   */
  async computeSalesState(eventId: number, now: number = Date.now()): Promise<SalesState | null> {
    const event = (await messengerEventModel().findOne({ id: eventId }).lean().exec()) as IEvent | null;
    if (!event) return null;
    const gate = evaluateSalesGate(event, now);
    if (gate) return gate;
    if (event.recurrence?.enabled === true) {
      const sessions = await (await this.eventSessionsService()).getSessionsWithAvailability(eventId, {
        purchasableOnly: true,
        now,
      });
      const soldOutUpcomingSession = sessions.length
        ? false
        : !!(await messengerEventSessionModel()
            .exists({ eventId, status: 'sold_out', date: { $gte: todayIct(now) } })
            .exec());
      return evaluateSalesAvailability({ recurring: true, purchasableSessions: sessions, soldOutUpcomingSession });
    }
    const remaining = await (await this.eventsService()).getAvailableTicketsCountByEventIds([eventId]);
    return evaluateSalesAvailability({ recurring: false, remainingSeats: remaining.get(eventId) ?? 0 });
  }

  @Cron('*/5 * * * *')
  async sweepSalesCron(): Promise<void> {
    await this.sweepSales().catch((error) =>
      this.logger.error(`Messenger sales sweep failed: ${describeMessengerError(error)}`),
    );
  }

  /**
   * Rechecks every enabled integration with a connected group: catches the transitions
   * nothing writes (sales cut-off reached, a show starting, reservations expiring).
   * Non-overlapping; one failing event never stops the others. Returns events checked.
   */
  async sweepSales(): Promise<number> {
    if (this.sweepRunning) return 0;
    this.sweepRunning = true;
    let checked = 0;
    try {
      const integrations = (await eventMessengerIntegrationModel()
        .find({ provider: 'line', enabled: true, 'line.groupId': { $ne: null } })
        .select({ eventId: 1 })
        .lean()
        .exec()) as Array<{ eventId: number }>;
      for (const { eventId } of integrations) {
        try {
          const result = await this.recheckSales(eventId);
          if (result.status === 'event_not_found') {
            this.logger.warn(`Messenger integration of missing event ${eventId} skipped by the sales sweep`);
            continue;
          }
          checked++;
        } catch (error) {
          this.logger.warn(`Messenger sales recheck of event ${eventId} failed: ${describeMessengerError(error)}`);
        }
      }
    } finally {
      this.sweepRunning = false;
    }
    return checked;
  }

  /* ------------------------------------------------------------ T5 review created */

  /** "New review (awaiting moderation)" right after the review is written (dedup `review:<id>`). */
  async notifyReviewCreated(reviewId: number): Promise<void> {
    const review = (await messengerReviewModel().findOne({ id: reviewId }).lean().exec()) as IReview | null;
    if (!review) return;
    const integration = await this.findLineIntegration(review.eventId);
    if (!integration || !this.canSend(integration, 'reviewCreated')) return;
    const event = (await messengerEventModel()
      .findOne({ id: review.eventId })
      .select({ id: 1, title: 1 })
      .lean()
      .exec()) as Pick<IEvent, 'id' | 'title'> | null;
    const text = buildReviewCreatedMessage({ event: event ?? { id: review.eventId }, review });
    await this.delivery.deliver(integration, 'review_created', `review:${review.id}`, text);
  }

  /* ------------------------------------------------------------------ internals */

  private async recheckSalesNow(eventId: number, reason?: string): Promise<SalesRecheckResult> {
    const integration = await this.findLineIntegration(eventId);
    if (!integration) return { status: 'no_integration' };
    const state = await this.computeSalesState(eventId);
    if (!state) return { status: 'event_not_found' };
    if (await this.isHeldByCheckouts(eventId, state, reason)) return { status: 'deferred', reason: state.reason };
    const previous = (await eventMessengerIntegrationModel()
      .findOneAndUpdate(
        { _id: integration._id, salesOpen: { $ne: state.open } },
        { $set: { salesOpen: state.open } },
        { new: false, timestamps: false },
      )
      .lean()
      .exec()) as LeanEventMessengerIntegration | null;
    if (!previous) return { status: 'unchanged', open: state.open };
    if (previous.salesOpen === null || previous.salesOpen === undefined) {
      return { status: 'baseline', open: state.open };
    }
    const printedReason = resolveSalesReason(state, reason);
    if (!this.canSend(previous, state.open ? 'salesOpened' : 'salesClosed')) {
      return { status: 'changed', open: state.open, reason: printedReason, delivery: null };
    }
    const event = (await messengerEventModel()
      .findOne({ id: eventId })
      .select({ id: 1, title: 1 })
      .lean()
      .exec()) as Pick<IEvent, 'id' | 'title'> | null;
    const text = buildSalesChangedMessage({ event: event ?? { id: eventId }, open: state.open, reason: printedReason });
    const delivery = await this.delivery.deliver(
      previous,
      state.open ? 'sales_opened' : 'sales_closed',
      `sales:${state.open ? 'opened' : 'closed'}:${Date.now()}`,
      text,
    );
    return { status: 'changed', open: state.open, reason: printedReason, delivery };
  }

  private serialiseSales<T>(eventId: number, task: () => Promise<T>): Promise<T> {
    const previous = this.salesChains.get(eventId) ?? Promise.resolve();
    const run = previous.then(task, task);
    const tail = run.catch(() => undefined);
    this.salesChains.set(eventId, tail);
    void tail.then(() => {
      if (this.salesChains.get(eventId) === tail) this.salesChains.delete(eventId);
    });
    return run;
  }

  private async findLineIntegration(eventId: number): Promise<LeanEventMessengerIntegration | null> {
    if (!Number.isFinite(eventId)) return null;
    return (await eventMessengerIntegrationModel()
      .findOne({ eventId, provider: 'line' })
      .lean()
      .exec()) as LeanEventMessengerIntegration | null;
  }

  private canSend(integration: LeanEventMessengerIntegration, trigger: EventMessengerTriggerKey): boolean {
    return messengerSendBlockedReason(integration, trigger) === null;
  }

  /**
   * `true` for a "sold out" (by seat count, not the organizer's mark) while an unpaid online
   * order of the event is still inside its payment window: it holds seats it gives back when
   * abandoned. The paid hook and the five-minute sweep decide again once it is paid or expired.
   */
  private async isHeldByCheckouts(eventId: number, state: SalesState, explicitReason?: string): Promise<boolean> {
    if (!maySoldOutBeCheckoutHolds(state, explicitReason)) return false;
    return !!(await messengerMockOrderModel()
      .exists({ event: eventId, status: 'wait', createdAt: { $gte: new Date(Date.now() - CHECKOUT_HOLD_MAX_MS) } })
      .exec());
  }

  /*
   * Resolved at call time. A file-level import of these services would close a require
   * cycle (events.service → this notifier → events.service) once the hooks are wired, and
   * a class read from a half-loaded module becomes `undefined` in Nest's DI metadata.
   */
  protected async eventsService(): Promise<Pick<EventsService, 'getAvailableTicketsCountByEventIds'>> {
    const { EventsService } = await import('../../events/events.service');
    return this.moduleRef.get(EventsService, { strict: false });
  }

  protected async eventSessionsService(): Promise<Pick<EventSessionsService, 'getSessionsWithAvailability'>> {
    const { EventSessionsService } = await import('../../event-sessions/event-sessions.service');
    return this.moduleRef.get(EventSessionsService, { strict: false });
  }
}
