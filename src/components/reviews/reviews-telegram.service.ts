import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

const TELEGRAM_API = 'https://api.telegram.org';

export type ReviewNotification = {
  reviewId: number;
  eventId: number;
  eventTitle: string;
  authorName: string;
  rating: number;
  message: string;
};

/**
 * Pushes every new review into a Telegram moderation chat with inline
 * Approve / Reject buttons, and edits the message once a moderator has acted.
 *
 * Configuration (all optional — when the token or chat id is missing the service
 * quietly does nothing, so review creation never depends on Telegram):
 *   TELEGRAM_REVIEWS_TOKEN     bot token; falls back to TELEGRAM_BOT_TOKEN
 *   TELEGRAM_REVIEWS_CHAT_ID   moderation chat id
 *   TELEGRAM_REVIEWS_WEBHOOK_SECRET  shared secret for the callback webhook
 */
@Injectable()
export class ReviewsTelegramService {
  private readonly logger = new Logger(ReviewsTelegramService.name);
  private readonly botToken: string;
  private readonly chatId: string;
  readonly webhookSecret: string;

  constructor(
    private readonly config: ConfigService,
    private readonly http: HttpService,
  ) {
    this.botToken = (
      this.config.get<string>('TELEGRAM_REVIEWS_TOKEN', '') ||
      this.config.get<string>('TELEGRAM_BOT_TOKEN', '')
    ).trim();
    this.chatId = this.config.get<string>('TELEGRAM_REVIEWS_CHAT_ID', '').trim();
    this.webhookSecret = this.config
      .get<string>('TELEGRAM_REVIEWS_WEBHOOK_SECRET', '')
      .trim();
  }

  isConfigured(): boolean {
    return Boolean(this.botToken && this.chatId);
  }

  private async call(method: string, body: Record<string, unknown>): Promise<unknown> {
    const url = `${TELEGRAM_API}/bot${this.botToken}/${method}`;
    const response = await firstValueFrom(
      this.http.post(url, body, { headers: { 'Content-Type': 'application/json' } }),
    );
    return response.data;
  }

  private stars(rating: number): string {
    const filled = Math.min(Math.max(Math.round(rating), 0), 5);
    return '⭐'.repeat(filled) + '☆'.repeat(5 - filled);
  }

  /** Best effort — failures are logged, never thrown at the caller. */
  async notifyNewReview(review: ReviewNotification): Promise<void> {
    if (!this.isConfigured()) {
      this.logger.debug(
        `Telegram reviews channel not configured; skipping notification for review ${review.reviewId}`,
      );
      return;
    }
    const text = [
      '📝 <b>Новый отзыв на модерацию</b>',
      '',
      `<b>Событие:</b> ${this.escape(review.eventTitle)} (#${review.eventId})`,
      `<b>Автор:</b> ${this.escape(review.authorName)}`,
      `<b>Оценка:</b> ${this.stars(review.rating)} (${review.rating}/5)`,
      '',
      this.escape(review.message),
    ].join('\n');

    try {
      await this.call('sendMessage', {
        chat_id: this.chatId,
        text,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Одобрить', callback_data: `review:approve:${review.reviewId}` },
              { text: '❌ Отклонить', callback_data: `review:reject:${review.reviewId}` },
            ],
          ],
        },
      });
    } catch (error) {
      this.logger.error(
        `Failed to notify Telegram about review ${review.reviewId}: ${(error as Error)?.message}`,
      );
    }
  }

  /** Replaces the inline keyboard with the moderation outcome. */
  async markResolved(
    chatId: number | string,
    messageId: number,
    originalText: string,
    outcome: 'approved' | 'rejected',
    moderator: string,
  ): Promise<void> {
    if (!this.botToken) return;
    const suffix =
      outcome === 'approved'
        ? `\n\n✅ <b>Одобрено</b> — ${this.escape(moderator)}`
        : `\n\n❌ <b>Отклонено</b> — ${this.escape(moderator)}`;
    try {
      await this.call('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: `${originalText}${suffix}`,
        parse_mode: 'HTML',
      });
    } catch (error) {
      this.logger.warn(`Failed to edit Telegram message: ${(error as Error)?.message}`);
    }
  }

  /** Long-polling fetch used by the local-dev moderation loop. */
  async getUpdates(offset: number): Promise<Array<Record<string, any>>> {
    if (!this.botToken) return [];
    const data = (await this.call('getUpdates', {
      offset,
      timeout: 0,
      allowed_updates: ['callback_query'],
    })) as { ok?: boolean; result?: Array<Record<string, any>>; description?: string };
    if (!data?.ok) {
      throw new Error(data?.description || 'getUpdates failed');
    }
    return data.result ?? [];
  }

  /** Clears any registered webhook so `getUpdates` is allowed. */
  async deleteWebhook(): Promise<void> {
    if (!this.botToken) return;
    try {
      await this.call('deleteWebhook', { drop_pending_updates: false });
    } catch (error) {
      this.logger.warn(`Failed to delete webhook: ${(error as Error)?.message}`);
    }
  }

  async answerCallback(callbackQueryId: string, text: string): Promise<void> {
    if (!this.botToken) return;
    try {
      await this.call('answerCallbackQuery', {
        callback_query_id: callbackQueryId,
        text,
      });
    } catch (error) {
      this.logger.warn(`Failed to answer callback query: ${(error as Error)?.message}`);
    }
  }

  private escape(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}
