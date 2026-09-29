import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

const TELEGRAM_API = 'https://api.telegram.org';

type TelegramLinkPreviewOptions = {
  is_disabled?: boolean;
  url?: string;
  prefer_small_media?: boolean;
  prefer_large_media?: boolean;
  show_above_text?: boolean;
};

export type TelegramSendMessageOptions = {
  disableWebPagePreview?: boolean;
  parseMode?: 'HTML';
  linkPreview?: {
    url: string;
    preferSmallMedia?: boolean;
    showAboveText?: boolean;
  };
};
type TelegramOkResponse = { ok: true; result?: { message_id: number } };
type TelegramErrResponse = { ok: false; description?: string };

@Injectable()
export class TelegramApiService {
  private readonly logger = new Logger(TelegramApiService.name);
  private readonly botToken: string;

  constructor(
    private readonly config: ConfigService,
    private readonly http: HttpService,
  ) {
    this.botToken = this.config.get<string>('TELEGRAM_BOT_TOKEN', '').trim();
  }

  isConfigured(): boolean {
    return Boolean(this.botToken);
  }

  async sendMessage(
    chatId: string,
    text: string,
    options?: TelegramSendMessageOptions,
  ): Promise<void> {
    if (!this.botToken) {
      throw new Error('Telegram bot is not configured');
    }
    const url = `${TELEGRAM_API}/bot${this.botToken}/sendMessage`;
    const body = new URLSearchParams({
      chat_id: chatId,
      text,
    });
    if (options?.linkPreview) {
      const linkPreviewOptions: TelegramLinkPreviewOptions = {
        url: options.linkPreview.url,
        prefer_small_media: options.linkPreview.preferSmallMedia ?? true,
        show_above_text: options.linkPreview.showAboveText ?? false,
      };
      body.append('link_preview_options', JSON.stringify(linkPreviewOptions));
    } else if (options?.disableWebPagePreview) {
      body.append('disable_web_page_preview', 'true');
    }
    if (options?.parseMode) {
      body.append('parse_mode', options.parseMode);
    }
    const { data } = await firstValueFrom(
      this.http.post<TelegramOkResponse | TelegramErrResponse>(url, body.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 60_000,
      }),
    );
    if (!data.ok) {
      const description = (data as TelegramErrResponse).description ?? 'Telegram sendMessage failed';
      this.logger.warn(`Telegram sendMessage failed for chat ${chatId}: ${description}`);
      throw new Error(description);
    }
  }

  async sendPhotoFromUrl(chatId: string, photoUrl: string, caption?: string): Promise<void> {
    if (!this.botToken) {
      throw new Error('Telegram bot is not configured');
    }
    const url = `${TELEGRAM_API}/bot${this.botToken}/sendPhoto`;
    const body = new URLSearchParams({
      chat_id: chatId,
      photo: photoUrl,
    });
    if (caption) {
      body.append('caption', caption);
    }
    const { data } = await firstValueFrom(
      this.http.post<TelegramOkResponse | TelegramErrResponse>(url, body.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 120_000,
      }),
    );
    if (!data.ok) {
      const description = (data as TelegramErrResponse).description ?? 'Telegram sendPhoto failed';
      throw new Error(description);
    }
  }

  async sendPhotoFromBuffer(
    chatId: string,
    buffer: Buffer,
    mimeType: string,
    filename: string,
    caption?: string,
  ): Promise<void> {
    if (!this.botToken) {
      throw new Error('Telegram bot is not configured');
    }
    const FormData = require('form-data') as typeof import('form-data');
    const url = `${TELEGRAM_API}/bot${this.botToken}/sendPhoto`;
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('photo', buffer, {
      filename,
      contentType: mimeType || 'image/jpeg',
    });
    if (caption) {
      form.append('caption', caption);
    }
    const { data } = await firstValueFrom(
      this.http.post<TelegramOkResponse | TelegramErrResponse>(url, form, {
        headers: form.getHeaders(),
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 120_000,
      }),
    );
    if (!data.ok) {
      const description = (data as TelegramErrResponse).description ?? 'Telegram sendPhoto failed';
      throw new Error(description);
    }
  }

  async sendDocumentFromBuffer(
    chatId: string,
    buffer: Buffer,
    mimeType: string,
    filename: string,
    caption?: string,
  ): Promise<void> {
    if (!this.botToken) {
      throw new Error('Telegram bot is not configured');
    }
    const FormData = require('form-data') as typeof import('form-data');
    const url = `${TELEGRAM_API}/bot${this.botToken}/sendDocument`;
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('document', buffer, {
      filename,
      contentType: mimeType || 'application/octet-stream',
    });
    if (caption) {
      form.append('caption', caption);
    }
    const { data } = await firstValueFrom(
      this.http.post<TelegramOkResponse | TelegramErrResponse>(url, form, {
        headers: form.getHeaders(),
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 120_000,
      }),
    );
    if (!data.ok) {
      const description = (data as TelegramErrResponse).description ?? 'Telegram sendDocument failed';
      throw new Error(description);
    }
  }
}
