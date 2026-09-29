import { Document, Schema } from 'mongoose';
import {
  DEFAULT_EVENT_MESSENGER_TRIGGERS,
  EVENT_MESSENGER_PROVIDERS,
  LINE_GROUP_SOURCES,
  type EventMessengerProvider,
  type EventMessengerTriggers,
  type LineGroupSource,
} from '../constants/event-messengers.constants';

/**
 * LINE part of an integration. Credentials are stored in plain text on purpose
 * (customer decision) and never leave the backend unmasked.
 */
export interface ILineIntegrationSettings {
  channelAccessToken: string;
  channelSecret: string;
  /** From `GET /v2/bot/info` when the token was saved. */
  botUserId: string | null;
  botBasicId: string | null;
  botName: string | null;
  groupId: string | null;
  groupName: string | null;
  groupJoinedAt: Date | null;
  groupSource: LineGroupSource | null;
  /**
   * Groups an admin disconnected (cleared or replaced the group id). The bot usually stays
   * in such a group, so a plain message from it must not connect it again; only a new
   * `join` from it or a manual group id does. Internal: not part of the admin view.
   */
  detachedGroupIds: string[];
}

/**
 * One messenger connection of one event (`{eventId, provider}` is unique). No autoinc
 * `id`: the document is addressed by its event, and by `webhookKey` from the webhook.
 */
export interface IEventMessengerIntegration extends Document {
  eventId: number;
  provider: EventMessengerProvider;
  enabled: boolean;
  /** Random hex that identifies the integration in the public webhook URL; never changes. */
  webhookKey: string;
  line: ILineIntegrationSettings;
  triggers: EventMessengerTriggers;
  /**
   * Last known event-level "tickets can be bought" state, for edge detection. `null`
   * until the first computation, which sets it without sending anything.
   */
  salesOpen: boolean | null;
  lastSentAt: Date | null;
  lastError: string | null;
  lastErrorAt: Date | null;
  createdByAdminId: number | null;
  updatedByAdminId: number | null;
  createdAt: Date;
  updatedAt: Date;
}

const LineIntegrationSettingsSchema = new Schema<ILineIntegrationSettings>(
  {
    channelAccessToken: { type: String, required: true },
    channelSecret: { type: String, required: true },
    botUserId: { type: String, default: null },
    botBasicId: { type: String, default: null },
    botName: { type: String, default: null },
    groupId: { type: String, default: null },
    groupName: { type: String, default: null },
    groupJoinedAt: { type: Date, default: null },
    // Mongoose skips the enum check for null, so `null` (no group) stays valid.
    groupSource: { type: String, enum: LINE_GROUP_SOURCES, default: null },
    detachedGroupIds: { type: [String], default: [] },
  },
  { _id: false },
);

const EventMessengerTriggersSchema = new Schema<EventMessengerTriggers>(
  {
    orderPaid: { type: Boolean, default: DEFAULT_EVENT_MESSENGER_TRIGGERS.orderPaid },
    sessionCancelled: { type: Boolean, default: DEFAULT_EVENT_MESSENGER_TRIGGERS.sessionCancelled },
    salesClosed: { type: Boolean, default: DEFAULT_EVENT_MESSENGER_TRIGGERS.salesClosed },
    salesOpened: { type: Boolean, default: DEFAULT_EVENT_MESSENGER_TRIGGERS.salesOpened },
    reviewCreated: { type: Boolean, default: DEFAULT_EVENT_MESSENGER_TRIGGERS.reviewCreated },
  },
  { _id: false },
);

export const EventMessengerIntegrationSchema = new Schema<IEventMessengerIntegration>(
  {
    eventId: { type: Number, required: true },
    provider: { type: String, enum: EVENT_MESSENGER_PROVIDERS, required: true },
    enabled: { type: Boolean, default: true },
    webhookKey: { type: String, required: true },
    line: { type: LineIntegrationSettingsSchema, required: true },
    triggers: { type: EventMessengerTriggersSchema, default: () => ({ ...DEFAULT_EVENT_MESSENGER_TRIGGERS }) },
    salesOpen: { type: Boolean, default: null },
    lastSentAt: { type: Date, default: null },
    lastError: { type: String, default: null },
    lastErrorAt: { type: Date, default: null },
    createdByAdminId: { type: Number, default: null },
    updatedByAdminId: { type: Number, default: null },
  },
  { timestamps: true, collection: 'event_messenger_integrations' },
);

EventMessengerIntegrationSchema.index({ eventId: 1, provider: 1 }, { unique: true });
EventMessengerIntegrationSchema.index({ webhookKey: 1 }, { unique: true });
