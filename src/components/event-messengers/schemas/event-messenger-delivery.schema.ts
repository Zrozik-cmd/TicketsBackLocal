import { Document, Schema } from 'mongoose';
import { autoIncrement } from 'mongoose-plugin-autoinc';
import {
  EVENT_MESSENGER_DELIVERY_KINDS,
  EVENT_MESSENGER_DELIVERY_STATUSES,
  EVENT_MESSENGER_PROVIDERS,
  type EventMessengerDeliveryKind,
  type EventMessengerDeliveryStatus,
  type EventMessengerProvider,
} from '../constants/event-messengers.constants';

/**
 * One message to one event's group. The document is inserted BEFORE the push: the
 * unique `{eventId, provider, dedupKey}` index is the exactly-once claim, so a second
 * hook call for the same order/review/session stops at the insert.
 */
export interface IEventMessengerDelivery extends Document {
  id: number;
  eventId: number;
  provider: EventMessengerProvider;
  kind: EventMessengerDeliveryKind;
  /**
   * `order:<orderId>` | `session-cancelled:<sessionId>[,<sessionId>…]` |
   * `sales:<closed|opened>:<ms>` | `review:<reviewId>` | `test:<ms>`.
   */
  dedupKey: string;
  text: string;
  status: EventMessengerDeliveryStatus;
  attempts: number;
  nextRetryAt: Date | null;
  lastError: string | null;
  sentAt: Date | null;
  /** UUID sent as `X-Line-Retry-Key` on every attempt, so LINE drops a repeated push. */
  retryKey: string;
  createdAt: Date;
  updatedAt: Date;
}

export const EventMessengerDeliverySchema = new Schema<IEventMessengerDelivery>(
  {
    id: { type: Number, unique: true },
    eventId: { type: Number, required: true },
    provider: { type: String, enum: EVENT_MESSENGER_PROVIDERS, required: true },
    kind: { type: String, enum: EVENT_MESSENGER_DELIVERY_KINDS, required: true },
    dedupKey: { type: String, required: true },
    text: { type: String, required: true },
    status: { type: String, enum: EVENT_MESSENGER_DELIVERY_STATUSES, required: true, default: 'pending' },
    attempts: { type: Number, required: true, default: 0 },
    nextRetryAt: { type: Date, default: null },
    lastError: { type: String, default: null },
    sentAt: { type: Date, default: null },
    retryKey: { type: String, required: true },
  },
  { timestamps: true, collection: 'event_messenger_deliveries' },
);

EventMessengerDeliverySchema.index({ eventId: 1, provider: 1, dedupKey: 1 }, { unique: true });
/*
 * One page of the admin delivery log is `{eventId, provider}` sorted by `{createdAt: -1, id: -1}`,
 * so the tiebreaker belongs in the index too: without it Mongo sorts the event's whole log in
 * memory on every page. The second index serves the `failedCount` above the table and the manual
 * retry's own `status: 'failed'` selection.
 */
EventMessengerDeliverySchema.index({ eventId: 1, provider: 1, createdAt: -1, id: -1 });
EventMessengerDeliverySchema.index({ eventId: 1, provider: 1, status: 1 });
EventMessengerDeliverySchema.index({ status: 1, nextRetryAt: 1 });

EventMessengerDeliverySchema.plugin(autoIncrement, {
  model: 'EventMessengerDelivery',
  field: 'id',
  startAt: 1,
});
