import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import mongoose from 'mongoose';
import { NotificationService } from '../../services/NotificationService/notification.service';
import { CustomerSchema, ICustomer } from '../customers/schemas/customer.schema';
import { EventSchema, IEvent, ILocalizedText } from '../events/schemas/event.schema';
import { todayIct } from '../events/utils/ict-date.util';
import { IMockOrder, MockOrderSchema } from '../mock-orders/schemas/mock-order.schema';
import { EventSessionSchema, IEventSession } from './schemas/event-session.schema';
import type { SessionCancelledEmailLocale } from './locales/session-cancelled-email.locales';
import {
  buildSessionCancelledEmail,
  type SessionCancelledEmailLine,
} from './utils/session-cancelled-email.util';

/**
 * Failed attempts after which an order is no longer retried (a dead mailbox, say).
 * Exported for the organizer's per-session order list, which reports the letter's state.
 */
export const MAX_CANCELLATION_EMAIL_ATTEMPTS = 5;
/**
 * How far back a run looks for cancelled shows, so old ones are not rescanned forever.
 * Exported for the same reason: a show older than this is never swept again.
 */
export const OWED_EMAILS_LOOKBACK_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

type OrderToNotify = Pick<
  IMockOrder,
  'id' | 'event' | 'customer' | 'locale' | 'tickets' | 'sessionCancellationNotifiedFor'
>;
type CancelledSession = Pick<IEventSession, 'id' | 'eventId' | 'date' | 'start' | 'end'>;

/**
 * Tells buyers that the show they hold tickets for was cancelled by the organizer.
 *
 * Every order remembers which cancelled sessions its buyer has been told about
 * (`sessionCancellationNotifiedFor`, written only once the mailer has accepted the
 * letter), so sending is driven by what is still owed rather than by the request that
 * cancelled the show. A restart halfway through, an SMTP failure, a half-finished
 * cancel request or an order paid after the cancellation are all caught up by the next
 * run — started right after a cancellation or such a payment, at boot, and every five
 * minutes — and no buyer is told twice.
 *
 * Kept apart from EventSessionsService on purpose: that service is also booted bare
 * (`new EventSessionsService()`) by `scripts/sync-event-sessions.ts`, while this one
 * needs the mailer. Models come from the shared mongoose registry, the same way every
 * other service here reaches them.
 */
@Injectable()
export class SessionCancellationNotifier implements OnApplicationBootstrap {
  private readonly logger = new Logger(SessionCancellationNotifier.name);
  /** The run in progress. Runs never overlap, so no order can be mailed twice. */
  private running: Promise<void> | null = null;
  /** A run was asked for while one was going: do one more right after it. */
  private rerunRequested = false;

  constructor(
    private readonly notificationService: NotificationService,
    private readonly config: ConfigService,
  ) {}

  private get eventModel(): mongoose.Model<IEvent> {
    return (
      (mongoose.models.Event as mongoose.Model<IEvent>) ??
      mongoose.model<IEvent>('Event', EventSchema)
    );
  }

  private get sessionModel(): mongoose.Model<IEventSession> {
    return (
      (mongoose.models.EventSession as mongoose.Model<IEventSession>) ??
      mongoose.model<IEventSession>('EventSession', EventSessionSchema)
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

  private resolveLocale(raw?: string): SessionCancelledEmailLocale {
    return raw === 'ru' || raw === 'th' || raw === 'en' ? raw : 'en';
  }

  private pickLocalizedText(
    value: ILocalizedText | undefined,
    locale: SessionCancelledEmailLocale,
    fallback = '',
  ): string {
    const order: SessionCancelledEmailLocale[] =
      locale === 'ru' ? ['ru', 'en', 'th'] : locale === 'th' ? ['th', 'en', 'ru'] : ['en', 'ru', 'th'];
    for (const key of order) {
      const text = value?.[key];
      if (typeof text === 'string' && text.trim()) return text.trim();
    }
    return fallback;
  }

  private getLogoUrl(): string {
    const base = this.config.get<string>('TICKETS_PUBLIC_BASE_URL', '').trim().replace(/\/+$/, '');
    return base ? `${base}/logo.png` : '';
  }

  onApplicationBootstrap(): void {
    // Letters a restart cut off go out as soon as the app is up, not at the next sweep.
    void mongoose.connection
      .asPromise()
      .then(() => this.sendOwedEmails())
      .catch((error) => this.logRunFailure(error));
  }

  @Cron('*/5 * * * *')
  async sweepOwedEmails(): Promise<void> {
    await this.sendOwedEmails().catch((error) => this.logRunFailure(error));
  }

  /**
   * After the organizer cancelled `cancelledSessionIds` of the event: counts the paid
   * orders of those sessions whose buyers are still owed the letter, starts sending in
   * the background (the caller does not wait) and returns that count. Pass every
   * cancelled session of the request, not only the ones it changed, so a retry after a
   * half-finished request still reaches the buyers the first attempt did not.
   */
  async queueCancellationEmails(eventId: number, cancelledSessionIds: number[]): Promise<number> {
    if (!cancelledSessionIds.length) return 0;
    const owed = await this.mockOrderModel
      .countDocuments(this.owedOrdersFilter(eventId, cancelledSessionIds))
      .exec();
    if (owed) this.startRun();
    return owed;
  }

  /**
   * A just-paid order with tickets for a session that is already cancelled — it was still
   * being paid when the organizer cancelled the date. Its buyer is owed the letter too;
   * resolves to whether one is on its way.
   */
  async queueForPaidOrder(order: Pick<IMockOrder, 'id' | 'event' | 'tickets'>): Promise<boolean> {
    const sessionIds = [
      ...new Set(
        (order.tickets ?? [])
          .map((line) => line.session)
          .filter((session): session is number => typeof session === 'number'),
      ),
    ];
    if (!sessionIds.length) return false;
    const cancelled = (await this.sessionModel
      .distinct('id', { eventId: order.event, id: { $in: sessionIds }, status: 'cancelled' })
      .exec()) as number[];
    if (!cancelled.length) return false;
    this.logger.warn(
      `Order ${order.id} was paid for cancelled session(s) ${cancelled.join(', ')} of event ${order.event}; sending the cancellation e-mail`,
    );
    this.startRun();
    return true;
  }

  private startRun(): void {
    void this.sendOwedEmails().catch((error) => this.logRunFailure(error));
  }

  private logRunFailure(error: unknown): void {
    this.logger.error(
      `Session cancellation e-mails run aborted: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  /**
   * Paid orders of the event holding a line on one of `sessionIds` their buyer has not
   * been told about yet, retries not used up.
   */
  private owedOrdersFilter(eventId: number, sessionIds: number[]): mongoose.FilterQuery<IMockOrder> {
    return {
      event: eventId,
      status: 'paid',
      'tickets.session': { $in: sessionIds },
      sessionCancellationEmailAttempts: { $not: { $gte: MAX_CANCELLATION_EMAIL_ATTEMPTS } },
      $expr: {
        $gt: [
          {
            $size: {
              $setDifference: [
                { $setIntersection: [{ $ifNull: ['$tickets.session', []] }, sessionIds] },
                { $ifNull: ['$sessionCancellationNotifiedFor', []] },
              ],
            },
          },
          0,
        ],
      },
    };
  }

  /** One run at a time; asking during a run folds into one more run after it. */
  private sendOwedEmails(): Promise<void> {
    if (this.running) {
      this.rerunRequested = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.rerunRequested = false;
          await this.sendOwedEmailsOnce();
        } while (this.rerunRequested);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  /**
   * Sends every letter still owed for the recently cancelled shows (dated from
   * `OWED_EMAILS_LOOKBACK_DAYS` back onwards): one per order, listing the lines of the
   * cancelled sessions its buyer has not been told about. Sequential, so a slow mailer
   * cannot pile up; each failure is recorded on the order and retried by a later run.
   */
  private async sendOwedEmailsOnce(now: number = Date.now()): Promise<void> {
    const sessions = (await this.sessionModel
      .find({ status: 'cancelled', date: { $gte: todayIct(now - OWED_EMAILS_LOOKBACK_DAYS * DAY_MS) } })
      .select({ id: 1, eventId: 1, date: 1, start: 1, end: 1 })
      .lean()
      .exec()) as unknown as CancelledSession[];
    if (!sessions.length) return;

    const cancelledByEvent = new Map<number, number[]>();
    for (const session of sessions) {
      cancelledByEvent.set(session.eventId, [...(cancelledByEvent.get(session.eventId) ?? []), session.id]);
    }
    const orders = (await this.mockOrderModel
      .find({
        $or: [...cancelledByEvent].map(([eventId, ids]) => this.owedOrdersFilter(eventId, ids)),
      })
      .select({ id: 1, event: 1, customer: 1, locale: 1, tickets: 1, sessionCancellationNotifiedFor: 1 })
      .sort({ id: 1 })
      .lean()
      .exec()) as unknown as OrderToNotify[];
    if (!orders.length) return;

    const [events, customers] = await Promise.all([
      this.eventModel
        .find({ id: { $in: [...new Set(orders.map((order) => order.event))] } })
        .select({ id: 1, title: 1, sectors: 1 })
        .lean()
        .exec(),
      this.customerModel
        .find({ id: { $in: [...new Set(orders.map((order) => order.customer))] } })
        .select({ id: 1, email: 1 })
        .lean()
        .exec(),
    ]);
    const eventById = new Map(events.map((event) => [event.id, event]));
    const sessionById = new Map(sessions.map((session) => [session.id, session]));
    const emailByCustomer = new Map(customers.map((customer) => [customer.id, customer.email]));
    const logoUrl = this.getLogoUrl();

    for (const order of orders) {
      const cancelled = new Set(cancelledByEvent.get(order.event) ?? []);
      const notified = new Set(order.sessionCancellationNotifiedFor ?? []);
      const owedLines = (order.tickets ?? []).filter(
        (line) =>
          typeof line.session === 'number' && cancelled.has(line.session) && !notified.has(line.session),
      );
      const owedSessionIds = [...new Set(owedLines.map((line) => line.session as number))];
      if (!owedSessionIds.length) continue;
      try {
        const to = emailByCustomer.get(order.customer)?.trim();
        if (!to) {
          throw new Error(`customer ${order.customer} has no e-mail`);
        }
        const event = eventById.get(order.event);
        const locale = this.resolveLocale(order.locale);
        const lines: SessionCancelledEmailLine[] = owedLines.map((line) => {
          const session = sessionById.get(line.session as number);
          const sector = event?.sectors?.find((candidate) => candidate.id === line.sectorId);
          const zone = sector?.zones?.find((candidate) => candidate.id === line.zoneId);
          return {
            // The denormalised copy is what the buyer's ticket shows; fall back to the session row.
            date: line.sessionDate ?? session?.date ?? '',
            start: line.sessionStart ?? session?.start ?? '',
            end: line.sessionEnd ?? session?.end,
            sectorName: this.pickLocalizedText(sector?.name, locale, line.sectorId),
            zoneName: this.pickLocalizedText(zone?.name, locale, line.zoneId),
            count: line.count ?? 0,
          };
        });

        const { subject, text, html } = buildSessionCancelledEmail({
          locale,
          eventTitle: this.pickLocalizedText(event?.title, locale, `Event #${order.event}`),
          orderId: order.id,
          lines,
          logoUrl,
        });
        // The throwing variant: a letter the SMTP server refused must stay owed.
        await this.notificationService.sendEmailOrThrow({ to, subject, text, html });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Session cancellation e-mail failed for order ${order.id}: ${message}`);
        await this.mockOrderModel
          .updateOne(
            { id: order.id },
            {
              $inc: { sessionCancellationEmailAttempts: 1 },
              $set: { sessionCancellationEmailLastError: message },
            },
          )
          .exec()
          .catch(() => undefined);
        continue;
      }

      this.logger.log(`Session cancellation e-mail sent: event=${order.event} order=${order.id}`);
      await this.mockOrderModel
        .updateOne(
          { id: order.id },
          {
            $addToSet: { sessionCancellationNotifiedFor: { $each: owedSessionIds } },
            $unset: { sessionCancellationEmailAttempts: 1, sessionCancellationEmailLastError: 1 },
          },
        )
        .exec()
        .catch((error) => {
          // Sent but not recorded: a later run would send this letter once more.
          this.logger.error(
            `Session cancellation e-mail for order ${order.id} sent but not recorded: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
    }
  }
}
