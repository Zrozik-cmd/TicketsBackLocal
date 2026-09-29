import { Injectable, Logger } from '@nestjs/common';
import {
  DELIVERY_MANUAL_RETRY_BUDGET_MS,
  DELIVERY_MAX_ATTEMPTS,
} from '../constants/event-messengers.constants';
import { describeMessengerError } from '../line/line-api.client';
import {
  assertMessengerEvent,
  eventMessengerDeliveryModel,
  eventMessengerIntegrationModel,
  type LeanEventMessengerDelivery,
  type LeanEventMessengerIntegration,
} from '../schemas/event-messenger.models';
import {
  manualRetryBatchSize,
  messengerSendBlockedReason,
  parseDeliveriesPaging,
  toDeliveryView,
  type EventMessengerDeliveryPage,
} from '../utils/event-messenger-deliveries.util';
import { EventMessengerDeliveryService } from './event-messenger-delivery.service';

/** What one manual "resend failed" run did; always `selected === sent + failed + skipped`. */
export type ManualRetryResult = {
  /**
   * Failed deliveries the run really handled — the limit, the server-side cap and the time
   * budget all bound it, so fewer than there are failed rows means "click again".
   */
  selected: number;
  sent: number;
  failed: number;
  /** Handled but not pushed: the message may not go out now, or another worker had the row. */
  skipped: number;
};

/**
 * The admin delivery log of one event: the paged list the LINE page shows and the manual
 * "resend the failed ones" action behind its button. Sending itself stays in
 * `EventMessengerDeliveryService` — this service only picks the rows and claims them.
 */
@Injectable()
export class EventMessengerDeliveriesService {
  private readonly logger = new Logger(EventMessengerDeliveriesService.name);

  constructor(private readonly delivery: EventMessengerDeliveryService) {}

  /** One page of this event's LINE deliveries, newest first, plus the totals above the table. */
  async list(
    eventId: number,
    limitRaw?: string | number | null,
    offsetRaw?: string | number | null,
  ): Promise<EventMessengerDeliveryPage> {
    await assertMessengerEvent(eventId);
    const { limit, offset } = parseDeliveriesPaging(limitRaw, offsetRaw);
    const filter = { eventId, provider: 'line' as const };
    const [rows, total, failedCount] = await Promise.all([
      eventMessengerDeliveryModel()
        .find(filter)
        .sort({ createdAt: -1, id: -1 })
        .skip(offset)
        .limit(limit)
        .lean()
        .exec() as unknown as Promise<LeanEventMessengerDelivery[]>,
      eventMessengerDeliveryModel().countDocuments(filter).exec(),
      eventMessengerDeliveryModel().countDocuments({ ...filter, status: 'failed' }).exec(),
    ]);
    return { items: rows.map(toDeliveryView), total, limit, offset, failedCount };
  }

  /**
   * Re-sends this event's failed LINE messages, newest first: `limit` of them (10/20/50) or all,
   * capped by `DELIVERY_MANUAL_RETRY_MAX` rows and by `DELIVERY_MANUAL_RETRY_BUDGET_MS` of wall
   * clock — the run is one synchronous request, and what it does not reach stays `failed` for the
   * next click. `test` messages are left out, exactly as the automatic path never retries them:
   * an old "test message" must not land in the customer group.
   *
   * Each row is checked against the shared push rule (`retryBlockedReason`: the integration, the
   * trigger, a sales edge the event has outlived), then claimed with a conditional
   * `failed → pending` update — the retry cron and a second click can never push the same row
   * twice. The claim raises `attempts` to `DELIVERY_MAX_ATTEMPTS - 1` (`$max`, so a longer history
   * is kept): the manual push is ONE extra attempt, after which the row is parked again instead of
   * re-arming the whole automatic budget. The push reuses the stored `retryKey`, so LINE itself
   * drops a message it had already accepted. Nothing here throws: a row that cannot be pushed is
   * counted, never raised.
   */
  async retryFailed(eventId: number, limit?: number | null): Promise<ManualRetryResult> {
    await assertMessengerEvent(eventId);
    const rows = (await eventMessengerDeliveryModel()
      .find({ eventId, provider: 'line', status: 'failed', kind: { $ne: 'test' } })
      .sort({ createdAt: -1, id: -1 })
      .limit(manualRetryBatchSize(limit))
      .lean()
      .exec()) as unknown as LeanEventMessengerDelivery[];
    const result: ManualRetryResult = { selected: 0, sent: 0, failed: 0, skipped: 0 };
    if (!rows.length) return result;

    const integration = (await eventMessengerIntegrationModel()
      .findOne({ eventId, provider: 'line' })
      .lean()
      .exec()) as LeanEventMessengerIntegration | null;
    const blocked = messengerSendBlockedReason(integration, null);
    if (blocked || !integration) {
      this.logger.warn(`Manual LINE retry for event ${eventId} sent nothing: ${blocked}`);
      return { selected: rows.length, sent: 0, failed: 0, skipped: rows.length };
    }

    const deadline = Date.now() + DELIVERY_MANUAL_RETRY_BUDGET_MS;
    for (const row of rows) {
      if (Date.now() >= deadline) {
        this.logger.warn(
          `Manual LINE retry for event ${eventId} stopped on its time budget after ${result.selected}` +
            ` of ${rows.length} rows; the rest stays failed for the next run`,
        );
        break;
      }
      result.selected++;
      await this.retryOne(row, integration, result);
    }
    return result;
  }

  /** Claims one failed delivery and pushes it; every outcome lands in `result`. */
  private async retryOne(
    row: LeanEventMessengerDelivery,
    integration: LeanEventMessengerIntegration,
    result: ManualRetryResult,
  ): Promise<void> {
    try {
      const blocked = await this.delivery.retryBlockedReason(row, integration);
      if (blocked) {
        // The same reasons the cron drops a retry for; the row keeps its status and its error.
        result.skipped++;
        return;
      }
      /*
       * A row that still has automatic attempts left keeps them: this push spends one and the
       * cron carries on with its usual backoff. A row that had already used them all gets exactly
       * one extra attempt and parks again afterwards (`$max` cannot lower a longer history).
       */
      const exhausted = (row.attempts ?? 0) >= DELIVERY_MAX_ATTEMPTS;
      const claimed = (await eventMessengerDeliveryModel()
        .findOneAndUpdate(
          { _id: row._id, status: 'failed' },
          exhausted
            ? { $set: { status: 'pending', nextRetryAt: null }, $max: { attempts: DELIVERY_MAX_ATTEMPTS - 1 } }
            : { $set: { status: 'pending', nextRetryAt: null } },
          { new: true },
        )
        .lean()
        .exec()) as LeanEventMessengerDelivery | null;
      if (!claimed) {
        // The retry cron (or a parallel click) took it between the read and the claim.
        result.skipped++;
        return;
      }
      // Retryable in principle (no `test` row reaches here); the raised `attempts` is what parks it.
      const outcome = await this.delivery.attempt(claimed, integration, true);
      if (outcome.status === 'sent') result.sent++;
      else result.failed++;
    } catch (error) {
      result.failed++;
      this.logger.warn(
        `Manual LINE retry of delivery ${row.id} (event ${row.eventId}) failed: ${describeMessengerError(error)}`,
      );
    }
  }
}
