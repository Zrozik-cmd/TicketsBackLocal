import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import type { IEvent } from '../../events/schemas/event.schema';
import {
  DEFAULT_EVENT_MESSENGER_TRIGGERS,
  EVENT_MESSENGER_ERROR,
  EVENT_MESSENGER_TRIGGER_KEYS,
  type EventMessengerTriggers,
  type LineGroupSource,
} from '../constants/event-messengers.constants';
import type { UpdateLineIntegrationDto } from '../dto/update-line-integration.dto';
import { LineApiClient, LineApiError, describeMessengerError, type LineBotInfo } from '../line/line-api.client';
import {
  assertMessengerEvent,
  ensureEventMessengerIndexes,
  eventMessengerDeliveryModel,
  eventMessengerIntegrationModel,
  isDuplicateKeyError,
  type LeanEventMessengerIntegration,
} from '../schemas/event-messenger.models';
import { isoOrNull as iso } from '../utils/event-messenger-deliveries.util';
import { buildTestMessage } from '../utils/event-messenger-messages.util';
import {
  buildLineWebhookUrl,
  maskSecret,
  nextDetachedGroupIds,
  parseLineWebhookBody,
  planLineGroupActions,
  resolvePublicApiBase,
  verifyLineSignature,
} from '../utils/line-webhook.util';
import { EventMessengerDeliveryService } from './event-messenger-delivery.service';
import { EventMessengersNotifierService } from './event-messengers-notifier.service';

export type LineIntegrationStatus = 'connected' | 'waiting_for_group' | 'disabled';

export type LineIntegrationView = {
  provider: 'line';
  enabled: boolean;
  status: LineIntegrationStatus;
  channelAccessTokenMasked: string;
  channelSecretMasked: string;
  botName: string | null;
  botBasicId: string | null;
  botUserId: string | null;
  groupId: string | null;
  groupName: string | null;
  groupJoinedAt: string | null;
  groupSource: LineGroupSource | null;
  webhookUrl: string;
  triggers: EventMessengerTriggers;
  lastSentAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type EventMessengersView = { eventId: number; line: LineIntegrationView | null };

/** What the admin request says about where it came from (for the webhook URL fallback). */
export type RequestOriginLike = {
  headers: Record<string, string | string[] | undefined>;
  protocol?: string | null;
};

function normalizeTriggers(triggers: Partial<EventMessengerTriggers> | null | undefined): EventMessengerTriggers {
  const out = { ...DEFAULT_EVENT_MESSENGER_TRIGGERS };
  for (const key of EVENT_MESSENGER_TRIGGER_KEYS) {
    if (typeof triggers?.[key] === 'boolean') out[key] = triggers[key] as boolean;
  }
  return out;
}

function toAdminId(adminId: string | number | null | undefined): number | null {
  const n = Number(adminId);
  return Number.isInteger(n) ? n : null;
}

/**
 * LINE integration of one event: the admin API (read / create-or-update / delete / test
 * / delivery log) and the webhook that connects the group the bot was added to.
 */
@Injectable()
export class LineIntegrationService {
  private readonly logger = new Logger(LineIntegrationService.name);
  /** Webhook follow-ups (group name lookup, sales baseline) still running; awaited by tests. */
  private readonly background = new Set<Promise<unknown>>();

  constructor(
    private readonly config: ConfigService,
    private readonly lineApi: LineApiClient,
    private readonly delivery: EventMessengerDeliveryService,
    private readonly notifier: EventMessengersNotifierService,
  ) {}

  /* ------------------------------------------------------------------ admin API */

  async getMessengers(eventId: number, request: RequestOriginLike): Promise<EventMessengersView> {
    await this.assertEvent(eventId);
    const integration = await this.findIntegration(eventId);
    return { eventId, line: integration ? this.toView(integration, request) : null };
  }

  async saveLine(
    eventId: number,
    dto: UpdateLineIntegrationDto,
    adminId: string | number | null,
    request: RequestOriginLike,
  ): Promise<LineIntegrationView> {
    await this.assertEvent(eventId);
    const existing = await this.findIntegration(eventId);
    const token = typeof dto.channelAccessToken === 'string' ? dto.channelAccessToken.trim() : undefined;
    const secret = typeof dto.channelSecret === 'string' ? dto.channelSecret.trim() : undefined;
    if (token === '' || secret === '' || (!existing && (!token || !secret))) {
      throw new BadRequestException(EVENT_MESSENGER_ERROR.LINE_CREDENTIALS_REQUIRED);
    }

    const effectiveToken = token ?? existing!.line.channelAccessToken;
    const tokenChanged = !existing || (token !== undefined && token !== existing.line.channelAccessToken);
    // Validate before anything is written: a rejected token saves nothing.
    const botInfo = tokenChanged ? await this.validateToken(effectiveToken) : null;

    const now = new Date();
    const numericAdminId = toAdminId(adminId);
    const groupSet: Record<string, unknown> = {};
    let groupConnected = false;
    if (dto.groupId !== undefined) {
      const nextGroupId = dto.groupId === null ? null : dto.groupId.trim();
      const currentGroupId = existing?.line.groupId ?? null;
      if (nextGroupId !== currentGroupId) {
        groupSet.groupId = nextGroupId;
        groupSet.groupSource = nextGroupId ? 'manual' : null;
        groupSet.groupJoinedAt = nextGroupId ? now : null;
        groupSet.groupName = nextGroupId ? await this.fetchGroupName(effectiveToken, nextGroupId) : null;
        // The bot stays in a group the admin disconnected: remember it so a plain message
        // there does not connect it again (a new `join` from it or a manual id still does).
        groupSet.detachedGroupIds = nextDetachedGroupIds(existing?.line.detachedGroupIds, currentGroupId, nextGroupId);
        groupConnected = !!nextGroupId && !existing?.line.groupId;
      }
    }

    if (!existing) {
      await ensureEventMessengerIndexes();
      try {
        await eventMessengerIntegrationModel().create({
          eventId,
          provider: 'line',
          enabled: dto.enabled ?? true,
          webhookKey: randomBytes(24).toString('hex'),
          line: {
            channelAccessToken: token,
            channelSecret: secret,
            botUserId: botInfo?.userId ?? null,
            botBasicId: botInfo?.basicId ?? null,
            botName: botInfo?.displayName ?? null,
            groupId: null,
            groupName: null,
            groupJoinedAt: null,
            groupSource: null,
            detachedGroupIds: [],
            ...groupSet,
          },
          triggers: normalizeTriggers(dto.triggers),
          salesOpen: null,
          lastSentAt: null,
          lastError: null,
          lastErrorAt: null,
          createdByAdminId: numericAdminId,
          updatedByAdminId: numericAdminId,
        });
      } catch (error) {
        if (isDuplicateKeyError(error)) {
          throw new ConflictException(EVENT_MESSENGER_ERROR.LINE_INTEGRATION_CONFLICT);
        }
        throw error;
      }
      await this.refreshBaseline(eventId);
    } else {
      const set: Record<string, unknown> = { updatedByAdminId: numericAdminId };
      if (tokenChanged && token) {
        set['line.channelAccessToken'] = token;
        set['line.botUserId'] = botInfo?.userId ?? null;
        set['line.botBasicId'] = botInfo?.basicId ?? null;
        set['line.botName'] = botInfo?.displayName ?? null;
      }
      if (secret !== undefined) set['line.channelSecret'] = secret;
      for (const [key, value] of Object.entries(groupSet)) set[`line.${key}`] = value;
      const reEnabled = dto.enabled === true && existing.enabled === false;
      if (typeof dto.enabled === 'boolean') set.enabled = dto.enabled;
      if (dto.triggers) {
        for (const key of EVENT_MESSENGER_TRIGGER_KEYS) {
          if (typeof dto.triggers[key] === 'boolean') set[`triggers.${key}`] = dto.triggers[key];
        }
      }
      await eventMessengerIntegrationModel().updateOne({ _id: existing._id }, { $set: set }).exec();
      // Whatever changed while nothing could be sent is not news: start from the current state.
      if (reEnabled || groupConnected) await this.refreshBaseline(eventId);
    }

    const saved = await this.findIntegration(eventId);
    if (!saved) throw new NotFoundException(EVENT_MESSENGER_ERROR.LINE_INTEGRATION_NOT_FOUND);
    return this.toView(saved, request);
  }

  async deleteLine(eventId: number): Promise<{ deleted: true }> {
    await this.assertEvent(eventId);
    const result = await eventMessengerIntegrationModel().deleteOne({ eventId, provider: 'line' }).exec();
    await eventMessengerDeliveryModel().deleteMany({ eventId, provider: 'line' }).exec();
    if (!result.deletedCount) {
      throw new NotFoundException(EVENT_MESSENGER_ERROR.LINE_INTEGRATION_NOT_FOUND);
    }
    return { deleted: true };
  }

  /** Sends the test message synchronously; works while the integration is disabled. */
  async sendTest(eventId: number): Promise<{ sent: true; deliveryId: number }> {
    const event = await this.assertEvent(eventId);
    const integration = await this.findIntegration(eventId);
    if (!integration) throw new NotFoundException(EVENT_MESSENGER_ERROR.LINE_INTEGRATION_NOT_FOUND);
    if (!integration.line?.groupId) {
      throw new BadRequestException(EVENT_MESSENGER_ERROR.LINE_GROUP_NOT_CONNECTED);
    }
    const outcome = await this.delivery.deliver(
      integration,
      'test',
      `test:${Date.now()}`,
      buildTestMessage(event),
      { retryable: false },
    );
    if (outcome.status === 'duplicate') {
      throw new ConflictException(EVENT_MESSENGER_ERROR.LINE_TEST_CONFLICT);
    }
    if (outcome.status === 'failed') {
      throw new BadGatewayException({
        statusCode: 502,
        message: EVENT_MESSENGER_ERROR.LINE_PUSH_FAILED,
        error: 'Bad Gateway',
        details: outcome.lineMessage ?? outcome.error,
        deliveryId: outcome.deliveryId,
      });
    }
    return { sent: true, deliveryId: outcome.deliveryId };
  }

  /* ------------------------------------------------------------------ webhook */

  /**
   * `POST integrations/line/webhook/:webhookKey`. Unknown key → 404, bad signature → 401.
   * A verified request is always answered with 200 (LINE's Verify sends `events: []`):
   * malformed bodies and unknown events are ignored, group changes are atomic updates,
   * and the group name lookup runs after the response.
   */
  async handleWebhook(
    webhookKey: string,
    rawBody: Buffer | null,
    signature: string | string[] | undefined,
  ): Promise<{ ok: true }> {
    const key = typeof webhookKey === 'string' ? webhookKey.trim() : '';
    const integration =
      key && key.length <= 128
        ? ((await eventMessengerIntegrationModel()
            .findOne({ webhookKey: key, provider: 'line' })
            .lean()
            .exec()) as LeanEventMessengerIntegration | null)
        : null;
    if (!integration) throw new NotFoundException(EVENT_MESSENGER_ERROR.LINE_WEBHOOK_NOT_FOUND);
    if (!verifyLineSignature(integration.line?.channelSecret, rawBody, signature)) {
      throw new UnauthorizedException(EVENT_MESSENGER_ERROR.LINE_SIGNATURE_INVALID);
    }
    const parsed = parseLineWebhookBody(rawBody as Buffer);
    if (!parsed) return { ok: true };

    const actions = planLineGroupActions(
      parsed.events,
      integration.line.groupId ?? null,
      integration.line.detachedGroupIds ?? null,
    );
    const model = eventMessengerIntegrationModel();
    let connectedGroupId: string | null = null;
    for (const action of actions) {
      try {
        const groupFields = (groupId: string | null, source: LineGroupSource | null) => ({
          'line.groupId': groupId,
          'line.groupName': null,
          'line.groupJoinedAt': groupId ? new Date() : null,
          'line.groupSource': source,
        });
        if (action.kind === 'join') {
          // Only while no group is connected, or a re-join of the connected one: an invite
          // into another group must never redirect buyer data away from the connected group.
          const result = await model
            .updateOne(
              { _id: integration._id, 'line.groupId': { $in: [null, action.groupId] } },
              { $set: groupFields(action.groupId, 'webhook'), $pull: { 'line.detachedGroupIds': action.groupId } },
            )
            .exec();
          if (result.matchedCount) {
            connectedGroupId = action.groupId;
            this.logger.log(`LINE bot joined a group for event ${integration.eventId}`);
          } else {
            this.warnIgnoredJoin(integration.eventId);
          }
        } else if (action.kind === 'ignored_join') {
          this.warnIgnoredJoin(integration.eventId);
        } else if (action.kind === 'capture') {
          const result = await model
            .updateOne(
              { _id: integration._id, 'line.groupId': null, 'line.detachedGroupIds': { $ne: action.groupId } },
              { $set: groupFields(action.groupId, 'webhook') },
            )
            .exec();
          if (result.modifiedCount) {
            connectedGroupId = action.groupId;
            this.logger.log(`LINE group captured from a group event for event ${integration.eventId}`);
          }
        } else {
          const result = await model
            .updateOne({ _id: integration._id, 'line.groupId': action.groupId }, { $set: groupFields(null, null) })
            .exec();
          if (result.modifiedCount) {
            if (connectedGroupId === action.groupId) connectedGroupId = null;
            this.logger.log(`LINE bot left the group of event ${integration.eventId}`);
          }
        }
      } catch (error) {
        this.logger.warn(
          `LINE webhook ${action.kind} for event ${integration.eventId} not applied: ${describeMessengerError(error)}`,
        );
      }
    }

    if (connectedGroupId) {
      const groupId = connectedGroupId;
      this.track(
        (async () => {
          const groupName = await this.fetchGroupName(integration.line.channelAccessToken, groupId);
          if (groupName) {
            await model
              .updateOne({ _id: integration._id, 'line.groupId': groupId }, { $set: { 'line.groupName': groupName } })
              .exec();
          }
          if (!integration.line.groupId) await this.refreshBaseline(integration.eventId);
        })(),
      );
    }
    return { ok: true };
  }

  /** Resolves once every webhook follow-up started so far has finished. */
  async whenIdle(): Promise<void> {
    while (this.background.size) {
      await Promise.allSettled([...this.background]);
    }
  }

  /* ------------------------------------------------------------------ internals */

  private warnIgnoredJoin(eventId: number): void {
    this.logger.warn(
      `LINE bot was added to another group while event ${eventId} has a connected group; the join was ignored ` +
        '(clear the group or remove the bot from it first to switch groups)',
    );
  }

  private track(task: Promise<unknown>): void {
    const tracked = task
      .catch((error) => this.logger.warn(`LINE webhook follow-up failed: ${describeMessengerError(error)}`))
      .finally(() => this.background.delete(tracked));
    this.background.add(tracked);
  }

  private assertEvent(eventId: number): Promise<Pick<IEvent, 'id' | 'title'>> {
    return assertMessengerEvent(eventId);
  }

  private async findIntegration(eventId: number): Promise<LeanEventMessengerIntegration | null> {
    return (await eventMessengerIntegrationModel()
      .findOne({ eventId, provider: 'line' })
      .lean()
      .exec()) as LeanEventMessengerIntegration | null;
  }

  private async validateToken(token: string): Promise<LineBotInfo> {
    try {
      return await this.lineApi.getBotInfo(token);
    } catch (error) {
      if (error instanceof LineApiError && error.isAuthError) {
        throw new BadRequestException({
          statusCode: 400,
          message: EVENT_MESSENGER_ERROR.LINE_TOKEN_INVALID,
          error: 'Bad Request',
          details: error.lineMessage ?? error.message,
        });
      }
      this.logger.warn(`LINE token check failed: ${describeMessengerError(error)}`);
      throw new BadGatewayException({
        statusCode: 502,
        message: EVENT_MESSENGER_ERROR.LINE_API_UNREACHABLE,
        error: 'Bad Gateway',
        details: describeMessengerError(error),
      });
    }
  }

  /** Best effort: `null` when LINE does not answer or the bot is not in that group. */
  private async fetchGroupName(token: string, groupId: string): Promise<string | null> {
    try {
      return (await this.lineApi.getGroupSummary(token, groupId)).groupName;
    } catch (error) {
      this.logger.warn(`LINE group summary unavailable: ${describeMessengerError(error)}`);
      return null;
    }
  }

  private async refreshBaseline(eventId: number): Promise<void> {
    try {
      await this.notifier.refreshSalesBaseline(eventId);
    } catch (error) {
      // Left `null`: the next recheck stores it, still without a message.
      this.logger.warn(`Sales baseline of event ${eventId} not stored: ${describeMessengerError(error)}`);
    }
  }

  private toView(integration: LeanEventMessengerIntegration, request: RequestOriginLike): LineIntegrationView {
    const line = integration.line ?? ({} as LeanEventMessengerIntegration['line']);
    const base = resolvePublicApiBase(this.config.get<string>('PUBLIC_API_URL'), request);
    return {
      provider: 'line',
      enabled: integration.enabled !== false,
      status: integration.enabled === false ? 'disabled' : line.groupId ? 'connected' : 'waiting_for_group',
      channelAccessTokenMasked: maskSecret(line.channelAccessToken),
      channelSecretMasked: maskSecret(line.channelSecret),
      botName: line.botName ?? null,
      botBasicId: line.botBasicId ?? null,
      botUserId: line.botUserId ?? null,
      groupId: line.groupId ?? null,
      groupName: line.groupName ?? null,
      groupJoinedAt: iso(line.groupJoinedAt),
      groupSource: line.groupSource ?? null,
      webhookUrl: buildLineWebhookUrl(base, integration.webhookKey),
      triggers: normalizeTriggers(integration.triggers),
      lastSentAt: iso(integration.lastSentAt),
      lastError: integration.lastError ?? null,
      lastErrorAt: iso(integration.lastErrorAt),
      createdAt: iso(integration.createdAt),
      updatedAt: iso(integration.updatedAt),
    };
  }
}
