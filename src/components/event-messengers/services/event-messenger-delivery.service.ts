import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import mongoose from 'mongoose';
import {
  DELIVERY_KIND_TRIGGER,
  DELIVERY_MAX_ATTEMPTS,
  DELIVERY_RETRY_BACKOFF_MINUTES,
  DELIVERY_RETRY_BATCH,
  DELIVERY_STALE_PENDING_MS,
  type EventMessengerDeliveryKind,
} from '../constants/event-messengers.constants';
import { LineApiClient, describeMessengerError } from '../line/line-api.client';
import {
  ensureEventMessengerIndexes,
  eventMessengerDeliveryModel,
  eventMessengerIntegrationModel,
  isDuplicateKeyError,
  type LeanEventMessengerDelivery,
  type LeanEventMessengerIntegration,
} from '../schemas/event-messenger.models';
import { messengerSendBlockedReason } from '../utils/event-messenger-deliveries.util';
import { fitLineText } from '../utils/event-messenger-messages.util';

export type DeliveryOutcome =
  /** The dedup key was already claimed: this message was (or is being) handled. */
  | { status: 'duplicate' }
  | { status: 'sent'; deliveryId: number }
  | { status: 'failed'; deliveryId: number; error: string; lineMessage: string | null; nextRetryAt: Date | null };

type DeliveryTarget = Pick<LeanEventMessengerIntegration, '_id' | 'eventId' | 'provider' | 'line'>;

/** Delay before the retry that follows failed attempt `attempts` (1-based); `null` when used up. */
export function nextRetryDelayMs(attempts: number): number | null {
  if (attempts >= DELIVERY_MAX_ATTEMPTS) return null;
  const minutes = DELIVERY_RETRY_BACKOFF_MINUTES[Math.min(attempts, DELIVERY_RETRY_BACKOFF_MINUTES.length) - 1];
  return minutes === undefined ? null : minutes * 60_000;
}

/**
 * Exactly-once delivery of group messages: claim (insert the delivery document; the
 * unique `{eventId, provider, dedupKey}` index rejects a second claim), push, record the
 * outcome. Failures are retried by a non-overlapping cron with 1/5/15/60-minute backoff,
 * 5 attempts in total, every attempt with the same `X-Line-Retry-Key`.
 */
@Injectable()
export class EventMessengerDeliveryService implements OnApplicationBootstrap {
  private readonly logger = new Logger(EventMessengerDeliveryService.name);
  private retryRunning = false;

  constructor(private readonly lineApi: LineApiClient) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await mongoose.connection.asPromise();
      await ensureEventMessengerIndexes();
      const recovered = await this.recoverStalePending();
      if (recovered) {
        this.logger.log(`Recovered ${recovered} interrupted messenger deliveries for retry`);
      }
    } catch (error) {
      this.logger.error(`Messenger deliveries boot check failed: ${describeMessengerError(error)}`);
    }
  }

  /**
   * Claims `dedupKey` and pushes `text` to the integration's group. The caller has
   * already checked that the integration is enabled, the trigger is on and a group is
   * connected. `retryable: false` (test messages) records a failure without scheduling
   * a retry.
   */
  async deliver(
    integration: DeliveryTarget,
    kind: EventMessengerDeliveryKind,
    dedupKey: string,
    text: string,
    options: { retryable?: boolean } = {},
  ): Promise<DeliveryOutcome> {
    await ensureEventMessengerIndexes();
    let delivery: LeanEventMessengerDelivery;
    try {
      const created = await eventMessengerDeliveryModel().create({
        eventId: integration.eventId,
        provider: integration.provider,
        kind,
        dedupKey,
        text: fitLineText(text),
        status: 'pending',
        attempts: 0,
        nextRetryAt: null,
        lastError: null,
        sentAt: null,
        retryKey: randomUUID(),
      });
      delivery = created.toObject() as unknown as LeanEventMessengerDelivery;
    } catch (error) {
      if (isDuplicateKeyError(error) && /dedupKey/.test(String((error as Error).message))) {
        return { status: 'duplicate' };
      }
      throw error;
    }
    return this.attempt(delivery, integration, options.retryable !== false);
  }

  /**
   * Pushes one claimed (`pending`) delivery and records the outcome. Public so the admin's
   * manual retry can re-send a row it claimed itself; ordinary senders go through `deliver`.
   */
  async attempt(
    delivery: Pick<LeanEventMessengerDelivery, '_id' | 'id' | 'attempts' | 'text' | 'retryKey'>,
    integration: DeliveryTarget,
    retryable: boolean,
  ): Promise<DeliveryOutcome> {
    const attempts = (delivery.attempts ?? 0) + 1;
    const groupId = integration.line?.groupId;
    try {
      if (!groupId) throw new Error('No LINE group connected');
      const result = await this.lineApi.pushText(
        integration.line.channelAccessToken,
        groupId,
        delivery.text,
        delivery.retryKey,
      );
      const now = new Date();
      await eventMessengerDeliveryModel()
        .updateOne(
          { _id: delivery._id },
          { $set: { status: 'sent', attempts, sentAt: now, nextRetryAt: null, lastError: null } },
        )
        .exec();
      await eventMessengerIntegrationModel()
        .updateOne({ _id: integration._id }, { $set: { lastSentAt: now, lastError: null, lastErrorAt: null } })
        .exec();
      if (result.alreadyAccepted) {
        this.logger.log(`Messenger delivery ${delivery.id}: LINE had already accepted this retry key`);
      }
      return { status: 'sent', deliveryId: delivery.id };
    } catch (error) {
      const message = describeMessengerError(error);
      const delay = retryable ? nextRetryDelayMs(attempts) : null;
      const now = new Date();
      const nextRetryAt = delay === null ? null : new Date(now.getTime() + delay);
      await eventMessengerDeliveryModel()
        .updateOne(
          { _id: delivery._id },
          { $set: { status: 'failed', attempts, nextRetryAt, lastError: message } },
        )
        .exec();
      await eventMessengerIntegrationModel()
        .updateOne({ _id: integration._id }, { $set: { lastError: message, lastErrorAt: now } })
        .exec();
      this.logger.warn(
        `Messenger delivery ${delivery.id} (event ${integration.eventId}) failed, attempt ${attempts}: ${message}` +
          (nextRetryAt ? `; retry at ${nextRetryAt.toISOString()}` : '; no more retries'),
      );
      const lineMessage = (error as { lineMessage?: string | null })?.lineMessage ?? null;
      return { status: 'failed', deliveryId: delivery.id, error: message, lineMessage, nextRetryAt };
    }
  }

  /** A `pending` delivery nobody is pushing any more (process died mid-push) goes back to the retry queue. */
  async recoverStalePending(now: Date = new Date()): Promise<number> {
    const stale = {
      status: 'pending',
      updatedAt: { $lt: new Date(now.getTime() - DELIVERY_STALE_PENDING_MS) },
    };
    const lastError = 'Interrupted before completion';
    const [retried, closed] = await Promise.all([
      eventMessengerDeliveryModel()
        .updateMany(
          { ...stale, attempts: { $lt: DELIVERY_MAX_ATTEMPTS }, kind: { $ne: 'test' } },
          { $set: { status: 'failed', nextRetryAt: now, lastError } },
        )
        .exec(),
      // A synchronous test message is never retried.
      eventMessengerDeliveryModel()
        .updateMany(
          { ...stale, $or: [{ kind: 'test' }, { attempts: { $gte: DELIVERY_MAX_ATTEMPTS } }] },
          { $set: { status: 'failed', nextRetryAt: null, lastError } },
        )
        .exec(),
    ]);
    return retried.modifiedCount + closed.modifiedCount;
  }

  @Cron('*/1 * * * *')
  async retryDueDeliveriesCron(): Promise<void> {
    await this.retryDueDeliveries().catch((error) =>
      this.logger.error(`Messenger delivery retry run failed: ${describeMessengerError(error)}`),
    );
  }

  /**
   * Retries failed deliveries whose `nextRetryAt` has come. Each one is claimed with a
   * conditional update (failed → pending), so two instances never push the same one.
   * A retry is dropped (no more attempts) for every reason `retryBlockedReason` names.
   * Returns the number attempted.
   */
  async retryDueDeliveries(now: Date = new Date()): Promise<number> {
    if (this.retryRunning) return 0;
    this.retryRunning = true;
    let attempted = 0;
    try {
      await this.recoverStalePending(now);
      for (let i = 0; i < DELIVERY_RETRY_BATCH; i++) {
        const claimed = (await eventMessengerDeliveryModel()
          .findOneAndUpdate(
            {
              status: 'failed',
              nextRetryAt: { $ne: null, $lte: now },
              attempts: { $lt: DELIVERY_MAX_ATTEMPTS },
            },
            { $set: { status: 'pending', nextRetryAt: null } },
            { sort: { nextRetryAt: 1 }, new: true },
          )
          .lean()
          .exec()) as LeanEventMessengerDelivery | null;
        if (!claimed) break;
        const integration = (await eventMessengerIntegrationModel()
          .findOne({ eventId: claimed.eventId, provider: claimed.provider })
          .lean()
          .exec()) as LeanEventMessengerIntegration | null;
        const skipReason = await this.retryBlockedReason(claimed, integration);
        if (skipReason || !integration) {
          await eventMessengerDeliveryModel()
            .updateOne(
              { _id: claimed._id },
              { $set: { status: 'failed', nextRetryAt: null, lastError: `Retry cancelled: ${skipReason}` } },
            )
            .exec();
          continue;
        }
        attempted++;
        await this.attempt(claimed, integration, claimed.kind !== 'test');
      }
    } finally {
      this.retryRunning = false;
    }
    return attempted;
  }

  /**
   * Why this failed delivery must not be pushed right now, or `null` — THE rule of both retry
   * paths, the cron above and the admin's manual "resend failed"
   * (`EventMessengerDeliveriesService.retryFailed`), so neither can push what the other would
   * drop. It is the send rule of every message (`messengerSendBlockedReason`) plus the freshness
   * of a sales edge, which needs the log itself.
   */
  async retryBlockedReason(
    delivery: Pick<LeanEventMessengerDelivery, 'id' | 'eventId' | 'provider' | 'kind'>,
    integration: LeanEventMessengerIntegration | null,
  ): Promise<string | null> {
    const blocked = messengerSendBlockedReason(integration, DELIVERY_KIND_TRIGGER[delivery.kind]);
    if (blocked || !integration) return blocked;
    return (await this.isStaleSalesEdge(delivery, integration)) ? 'sales state changed' : null;
  }

  /**
   * A late "Sales closed/opened" must not contradict what the group was told since: it is
   * stale when the stored `salesOpen` no longer matches it, or when a newer sales edge of
   * the event exists (that one already told the group, or is retried itself).
   */
  private async isStaleSalesEdge(
    delivery: Pick<LeanEventMessengerDelivery, 'id' | 'eventId' | 'provider' | 'kind'>,
    integration: Pick<LeanEventMessengerIntegration, 'salesOpen'>,
  ): Promise<boolean> {
    if (delivery.kind !== 'sales_closed' && delivery.kind !== 'sales_opened') return false;
    if (integration.salesOpen !== (delivery.kind === 'sales_opened')) return true;
    const newer = await eventMessengerDeliveryModel()
      .exists({
        eventId: delivery.eventId,
        provider: delivery.provider,
        kind: { $in: ['sales_closed', 'sales_opened'] },
        id: { $gt: delivery.id },
      })
      .exec();
    return !!newer;
  }
}
