import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import mongoose from 'mongoose';
import { TELEGRAM_BOT_MESSAGES } from '../constants/telegram.constants';
import {
  ITelegramUser,
  TelegramUserSchema,
} from '../schemas/telegram-user.schema';
import { TelegramApiService } from './telegram-api.service';
import { normalizeTelegramUsernameFromBot } from '../utils/telegram-username.util';

type TelegramUserPayload = {
  id: number;
  username?: string;
};

type TelegramChatPayload = {
  id: number;
};

type TelegramMessagePayload = {
  message_id: number;
  text?: string;
  from?: TelegramUserPayload;
  chat?: TelegramChatPayload;
};

type TelegramUpdatePayload = {
  update_id: number;
  message?: TelegramMessagePayload;
};

@Injectable()
export class TelegramBotService {
  private readonly logger = new Logger(TelegramBotService.name);
  private readonly webhookSecret: string;

  constructor(
    private readonly config: ConfigService,
    private readonly telegramApi: TelegramApiService,
  ) {
    this.webhookSecret = this.config.get<string>('TELEGRAM_WEBHOOK_SECRET', '').trim();
  }

  private get telegramUserModel(): mongoose.Model<ITelegramUser> {
    return (mongoose.models.TelegramUser as mongoose.Model<ITelegramUser>) ??
      mongoose.model<ITelegramUser>('TelegramUser', TelegramUserSchema);
  }

  assertWebhookSecret(secretHeader: string | undefined): void {
    if (!this.webhookSecret) {
      return;
    }
    if (!secretHeader || secretHeader !== this.webhookSecret) {
      throw new UnauthorizedException('Invalid Telegram webhook secret');
    }
  }

  async handleWebhookUpdate(update: TelegramUpdatePayload): Promise<{ ok: true }> {
    const message = update.message;
    if (!message?.text || message.text.trim() !== '/start') {
      return { ok: true };
    }

    const chatId = message.chat?.id;
    if (chatId == null) {
      return { ok: true };
    }

    const reply = async (text: string): Promise<void> => {
      if (!this.telegramApi.isConfigured()) {
        this.logger.warn('TELEGRAM_BOT_TOKEN missing; cannot reply to /start');
        return;
      }
      try {
        await this.telegramApi.sendMessage(String(chatId), text);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Failed to reply to Telegram /start: ${msg}`);
      }
    };

    const from = message.from;
    if (!from?.username) {
      await reply(TELEGRAM_BOT_MESSAGES.NO_USERNAME);
      return { ok: true };
    }

    const normalizedUsername = normalizeTelegramUsernameFromBot(from.username);
    if (!normalizedUsername) {
      await reply(TELEGRAM_BOT_MESSAGES.NO_USERNAME);
      return { ok: true };
    }

    const matches = await this.telegramUserModel
      .find({ usernameFromAdmin: normalizedUsername })
      .exec();

    if (matches.length === 0) {
      await reply(TELEGRAM_BOT_MESSAGES.NOT_IN_LIST);
      return { ok: true };
    }

    const now = new Date();
    await this.telegramUserModel.updateMany(
      { usernameFromAdmin: normalizedUsername },
      {
        $set: {
          realTelegramUserId: String(from.id),
          realTelegramUsername: normalizedUsername,
          chatId: String(chatId),
          status: 'connected',
          startedAt: now,
        },
      },
    );

    await reply(TELEGRAM_BOT_MESSAGES.CONNECTED);
    this.logger.log(
      `Telegram /start connected username=${normalizedUsername} chatId=${chatId} records=${matches.length}`,
    );

    return { ok: true };
  }
}
