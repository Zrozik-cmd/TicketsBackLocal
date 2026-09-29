import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ReviewsTelegramService } from './reviews-telegram.service';
import { ReviewsService } from './reviews.service';

export type TelegramCallbackQuery = {
  id: string;
  data?: string;
  from?: { id: number; username?: string; first_name?: string };
  message?: {
    message_id: number;
    text?: string;
    chat?: { id: number };
  };
};

/**
 * Applies moderation decisions coming from the Telegram inline buttons.
 *
 * The same handler serves two delivery modes:
 *  - **webhook** (production): Telegram POSTs to `/api/telegram/reviews-webhook`.
 *  - **long polling** (local dev): Telegram cannot reach `localhost`, so when
 *    `TELEGRAM_REVIEWS_POLLING=true` we pull updates with `getUpdates` instead.
 *    Never enable both at once — Telegram refuses `getUpdates` while a webhook is set.
 */
@Injectable()
export class ReviewsTelegramUpdatesService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(ReviewsTelegramUpdatesService.name);
  private readonly pollingEnabled: boolean;
  private pollTimer: NodeJS.Timeout | null = null;
  private offset = 0;
  private polling = false;

  constructor(
    private readonly config: ConfigService,
    private readonly reviewsService: ReviewsService,
    private readonly telegram: ReviewsTelegramService,
  ) {
    this.pollingEnabled =
      this.config.get<string>('TELEGRAM_REVIEWS_POLLING', '').trim().toLowerCase() ===
      'true';
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.pollingEnabled || !this.telegram.isConfigured()) return;
    // A registered webhook would make getUpdates fail with 409.
    await this.telegram.deleteWebhook();
    this.logger.log('Telegram review moderation: long-polling mode enabled');
    this.pollTimer = setInterval(() => void this.pollOnce(), 3000);
  }

  onApplicationShutdown(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private async pollOnce(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const updates = await this.telegram.getUpdates(this.offset);
      for (const update of updates) {
        this.offset = Math.max(this.offset, (update.update_id ?? 0) + 1);
        if (update.callback_query) {
          await this.handleCallbackQuery(update.callback_query);
        }
      }
    } catch (error) {
      this.logger.warn(`Telegram polling failed: ${(error as Error)?.message}`);
    } finally {
      this.polling = false;
    }
  }

  /**
   * Handles one `review:<approve|reject>:<id>` button press. Safe to call twice for
   * the same review: an already-moderated review just answers with its current state.
   */
  async handleCallbackQuery(callback: TelegramCallbackQuery): Promise<void> {
    if (!callback?.data) return;

    const [scope, action, rawId] = callback.data.split(':');
    if (scope !== 'review') return;
    if (action !== 'approve' && action !== 'reject') return;

    const reviewId = Number(rawId);
    if (!Number.isInteger(reviewId)) return;

    const moderator =
      callback.from?.username ||
      callback.from?.first_name ||
      `tg:${callback.from?.id ?? 'unknown'}`;

    try {
      const review = await this.reviewsService.findById(reviewId);
      if (!review) {
        await this.telegram.answerCallback(callback.id, 'Отзыв не найден');
        return;
      }
      if (review.status !== 'pending') {
        await this.telegram.answerCallback(
          callback.id,
          review.status === 'approved' ? 'Уже одобрен' : 'Уже отклонён',
        );
        return;
      }

      const outcome = action === 'approve' ? 'approved' : 'rejected';
      await this.reviewsService.setStatus(reviewId, outcome, `telegram:${moderator}`);
      await this.telegram.answerCallback(
        callback.id,
        outcome === 'approved' ? 'Отзыв одобрен' : 'Отзыв отклонён',
      );
      if (callback.message?.chat?.id && callback.message.message_id) {
        await this.telegram.markResolved(
          callback.message.chat.id,
          callback.message.message_id,
          callback.message.text ?? '',
          outcome,
          moderator,
        );
      }
    } catch (error) {
      this.logger.error(
        `Failed to handle review callback ${callback.data}: ${(error as Error)?.message}`,
      );
    }
  }
}
