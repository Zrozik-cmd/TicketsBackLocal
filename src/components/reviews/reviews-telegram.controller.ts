import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ReviewsTelegramUpdatesService,
  type TelegramCallbackQuery,
} from './reviews-telegram-updates.service';
import { ReviewsTelegramService } from './reviews-telegram.service';

type TelegramUpdate = {
  update_id: number;
  callback_query?: TelegramCallbackQuery;
};

/**
 * Webhook for the Approve / Reject buttons attached to each review notification.
 *
 * Telegram cannot reach a `localhost` URL, so this is the production path; for local
 * work set `TELEGRAM_REVIEWS_POLLING=true` and the same handler runs off `getUpdates`.
 *
 *   https://api.telegram.org/bot<TOKEN>/setWebhook
 *     ?url=<PUBLIC_API_BASE>/api/telegram/reviews-webhook
 *     &secret_token=<TELEGRAM_REVIEWS_WEBHOOK_SECRET>
 */
@Controller('api/telegram')
export class ReviewsTelegramController {
  constructor(
    private readonly updates: ReviewsTelegramUpdatesService,
    private readonly telegram: ReviewsTelegramService,
  ) {}

  @Post('reviews-webhook')
  @HttpCode(200)
  async handle(
    @Headers('x-telegram-bot-api-secret-token') secret: string | undefined,
    @Body() update: TelegramUpdate,
  ): Promise<{ ok: true }> {
    if (this.telegram.webhookSecret && secret !== this.telegram.webhookSecret) {
      throw new UnauthorizedException('Invalid webhook secret');
    }
    if (update?.callback_query) {
      await this.updates.handleCallbackQuery(update.callback_query);
    }
    return { ok: true };
  }
}
