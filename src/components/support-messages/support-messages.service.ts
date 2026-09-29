import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import FormData = require('form-data')
import { SendSupportMessageDto } from './dto/send-support-message.dto';

type UploadedAttachment = {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
};

const TELEGRAM_API = 'https://api.telegram.org';
const MAX_MESSAGE_LENGTH = 4096;
const MAX_CAPTION_LENGTH = 1024;
const ALLOWED_ATTACHMENT_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/svg+xml',
]);

type TelegramOkResponse = { ok: true; result?: { message_id: number } };
type TelegramErrResponse = { ok: false; description?: string };

type InputMediaItem = {
  type: string;
  media: string;
  caption?: string;
  parse_mode?: string;
};

@Injectable()
export class SupportMessagesService {
  private readonly logger = new Logger(SupportMessagesService.name);
  private readonly botToken: string;
  private readonly chatId: string;

  constructor(
    private readonly config: ConfigService,
    private readonly http: HttpService,
  ) {
    this.botToken = process.env.TELEGRAM_SUPPORT_TOKEN!;
    this.chatId = process.env.TELEGRAM_SUPPORT_CHANNEL_ID!;

    console.log('TELEGRAM_SUPPORT_TOKEN:', this.botToken);
    console.log('TELEGRAM_SUPPORT_CHANNEL_ID:', this.chatId);
  }

  async sendToTelegram(
    dto: SendSupportMessageDto,
    files: UploadedAttachment[] | undefined,
  ): Promise<{ ok: true }> {
    if (!this.botToken || !this.chatId) {
      this.logger.error(
        'TELEGRAM_SUPPORT_BOT_TOKEN or TELEGRAM_SUPPORT_CHAT_ID is not configured',
      );
      throw new ServiceUnavailableException('Support messaging is not configured');
    }

    const bodyHtml = this.formatTicketHtml(dto);
    const bodyPlain = this.formatTicketPlain(dto);

    const safeFiles = (files ?? []).filter((f) =>
      ALLOWED_ATTACHMENT_MIMES.has((f.mimetype || '').toLowerCase()),
    );

    if (safeFiles.length === 0) {
      await this.sendMessageHtmlOrPlainChunks(bodyHtml, bodyPlain);
      return { ok: true };
    }

    if (safeFiles.length === 1) {
      await this.sendMessageHtmlWithImg(bodyHtml, bodyPlain, safeFiles[0]);
      return { ok: true };
    }

    await this.sendMessageHtmlWithAlbum(bodyHtml, bodyPlain, safeFiles);
    return { ok: true };
  }

  /**
   * Same bot/channel as support tickets. Best-effort: does not throw (logs on failure)
   * so organizer APIs still succeed if Telegram is down or misconfigured.
   */
  async notifyEventModerationChannel(payload: {
    eventId: number;
    title: string;
    kind: 'created' | 'status_changed';
  }): Promise<void> {
    if (!this.botToken || !this.chatId) {
      this.logger.warn(
        'TELEGRAM_SUPPORT_TOKEN or TELEGRAM_SUPPORT_CHANNEL_ID missing; skipping event moderation notice',
      );
      return;
    }
    const e = (s: string) => this.escapeHtml(s);
    const headline =
      payload.kind === 'created'
        ? 'Событие создано и на модерации'
        : 'Событие переведено на модерацию';
    const text = [
      `<b>${e(headline)}</b>`,
      '',
      `<b>${e('ID события')}:</b> ${e(String(payload.eventId))}`,
      `<b>${e('Название')}:</b> ${e(payload.title)}`,
    ].join('\n');
    try {
      await this.telegramSendMessage(text, true);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Event moderation Telegram notice failed: ${msg}`);
    }
  }

  /**
   * Як у sendMessageMarkdownWithImg: одне фото/документ — caption (HTML) якщо ≤1024,
   * інакше текст окремо, потім медіа з reply_to на останнє текстове повідомлення.
   */
  private async sendMessageHtmlWithImg(
    bodyHtml: string,
    bodyPlain: string,
    file: UploadedAttachment,
  ): Promise<void> {
    const mime = (file.mimetype || '').toLowerCase();
    const isPhoto =
      mime === 'image/png' || mime === 'image/jpeg' || mime === 'image/jpg';

    if (bodyHtml.length <= MAX_CAPTION_LENGTH) {
      if (isPhoto) {
        await this.telegramSendPhoto(file, { caption: bodyHtml, parse_mode: 'HTML' });
      } else {
        await this.telegramSendDocument(file, { caption: bodyHtml, parse_mode: 'HTML' });
      }
      return;
    }

    const lastTextId = await this.sendMessageHtmlOrPlainReturnLastId(bodyHtml, bodyPlain);
    if (isPhoto) {
      await this.telegramSendPhoto(file, { reply_to_message_id: lastTextId });
    } else {
      await this.telegramSendDocument(file, { reply_to_message_id: lastTextId });
    }
  }

  /** Кілька вкладень: caption на альбомі, якщо текст ≤1024; інакше як у прикладі — текст, потім альбом з reply. */
  private async sendMessageHtmlWithAlbum(
    bodyHtml: string,
    bodyPlain: string,
    files: UploadedAttachment[],
  ): Promise<void> {
    if (bodyHtml.length <= MAX_CAPTION_LENGTH) {
      await this.telegramSendMediaGroupWithCaption(files, bodyHtml);
      return;
    }

    const lastTextId = await this.sendMessageHtmlOrPlainReturnLastId(bodyHtml, bodyPlain);
    await this.telegramSendMediaGroupReply(files, lastTextId);
  }

  private async sendMessageHtmlOrPlainChunks(
    bodyHtml: string,
    bodyPlain: string,
  ): Promise<void> {
    if (bodyHtml.length <= MAX_MESSAGE_LENGTH) {
      await this.telegramSendMessage(bodyHtml, true);
      return;
    }
    const chunks = this.splitTelegramChunks(bodyPlain);
    for (const chunk of chunks) {
      await this.telegramSendMessage(chunk, false);
    }
  }

  private async sendMessageHtmlOrPlainReturnLastId(
    bodyHtml: string,
    bodyPlain: string,
  ): Promise<number> {
    if (bodyHtml.length <= MAX_MESSAGE_LENGTH) {
      return this.telegramSendMessageReturningId(bodyHtml, true);
    }
    const chunks = this.splitTelegramChunks(bodyPlain);
    let lastId = 0;
    for (const chunk of chunks) {
      lastId = await this.telegramSendMessageReturningId(chunk, false);
    }
    return lastId;
  }

  private escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  private formatTicketHtml(dto: SendSupportMessageDto): string {
    const e = (x: string) => this.escapeHtml(x);
    const lines: string[] = [
      `<b>${e('Новый тикет поддержки')}</b>`,
      '',
      `<b>${e('Email')}:</b> ${e(dto.email)}`,
      `<b>${e('Отдел')}:</b> ${e(dto.department)}`,
      `<b>${e('Тема')}:</b> ${e(dto.subject)}`,
      `<b>${e('Важность')}:</b> ${e(dto.priority)}`,
      `<b>${e('Заказ отсутствует в списке')}:</b> ${dto.isOrderMissing ? e('да') : e('нет')}`,
    ];
    if (dto.orderId?.trim()) {
      lines.push(`<b>${e('Заказ')}:</b> ${e(dto.orderId.trim())}`);
    }
    lines.push('', `<b>${e('Сообщение')}:</b>`, e(dto.message));
    return lines.join('\n');
  }

  private formatTicketPlain(dto: SendSupportMessageDto): string {
    const e = (x: string) => this.escapeHtml(x);
    const lines: string[] = [
      e('Новый тикет поддержки'),
      '',
      `${e('Email')}: ${e(dto.email)}`,
      `${e('Отдел')}: ${e(dto.department)}`,
      `${e('Тема')}: ${e(dto.subject)}`,
      `${e('Важность')}: ${e(dto.priority)}`,
      `${e('Заказ отсутствует в списке')}: ${dto.isOrderMissing ? e('да') : e('нет')}`,
    ];
    if (dto.orderId?.trim()) {
      lines.push(`${e('Заказ')}: ${e(dto.orderId.trim())}`);
    }
    lines.push('', `${e('Сообщение')}:`, e(dto.message));
    return lines.join('\n');
  }

  private splitTelegramChunks(text: string): string[] {
    if (text.length <= MAX_MESSAGE_LENGTH) {
      return [text];
    }
    const chunks: string[] = [];
    let offset = 0;
    while (offset < text.length) {
      chunks.push(text.slice(offset, offset + MAX_MESSAGE_LENGTH));
      offset += MAX_MESSAGE_LENGTH;
    }
    return chunks;
  }

  private async telegramSendMessage(text: string, html: boolean): Promise<void> {
    const url = `${TELEGRAM_API}/bot${this.botToken}/sendMessage`;
    const body = new URLSearchParams({
      chat_id: this.chatId,
      text,
    });
    if (html) {
      body.append('parse_mode', 'HTML');
    }
    const { data } = await firstValueFrom(
      this.http.post<TelegramOkResponse | TelegramErrResponse>(url, body.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 60_000,
      }),
    );
    if (!data.ok) {
      this.logger.warn(`Telegram sendMessage failed: ${JSON.stringify(data)}`);
      throw new ServiceUnavailableException(
        (data as TelegramErrResponse).description ?? 'Telegram sendMessage failed',
      );
    }
  }

  private async telegramSendMessageReturningId(text: string, html: boolean): Promise<number> {
    const url = `${TELEGRAM_API}/bot${this.botToken}/sendMessage`;
    const body = new URLSearchParams({
      chat_id: this.chatId,
      text,
    });
    if (html) {
      body.append('parse_mode', 'HTML');
    }
    const { data } = await firstValueFrom(
      this.http.post<TelegramOkResponse | TelegramErrResponse>(url, body.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 60_000,
      }),
    );
    if (!data.ok) {
      this.logger.warn(`Telegram sendMessage failed: ${JSON.stringify(data)}`);
      throw new ServiceUnavailableException(
        (data as TelegramErrResponse).description ?? 'Telegram sendMessage failed',
      );
    }
    const id = (data as TelegramOkResponse).result?.message_id;
    if (typeof id !== 'number') {
      throw new ServiceUnavailableException('Telegram sendMessage returned no message_id');
    }
    return id;
  }

  private async telegramSendPhoto(
    file: UploadedAttachment,
    opts: {
      caption?: string;
      parse_mode?: 'HTML';
      reply_to_message_id?: number;
    },
  ): Promise<void> {
    const url = `${TELEGRAM_API}/bot${this.botToken}/sendPhoto`;
    const form = new FormData();
    form.append('chat_id', this.chatId);
    form.append('photo', file.buffer, {
      filename: file.originalname || 'attachment.jpg',
      contentType: file.mimetype || 'image/jpeg',
    });
    if (opts.caption !== undefined) {
      form.append('caption', opts.caption);
    }
    if (opts.parse_mode) {
      form.append('parse_mode', opts.parse_mode);
    }
    if (opts.reply_to_message_id !== undefined) {
      form.append('reply_to_message_id', String(opts.reply_to_message_id));
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
      this.logger.warn(`Telegram sendPhoto failed: ${JSON.stringify(data)}`);
      throw new ServiceUnavailableException(
        (data as TelegramErrResponse).description ?? 'Telegram sendPhoto failed',
      );
    }
  }

  private async telegramSendDocument(
    file: UploadedAttachment,
    opts: {
      caption?: string;
      parse_mode?: 'HTML';
      reply_to_message_id?: number;
    },
  ): Promise<void> {
    const url = `${TELEGRAM_API}/bot${this.botToken}/sendDocument`;
    const form = new FormData();
    form.append('chat_id', this.chatId);
    form.append('document', file.buffer, {
      filename: file.originalname || 'attachment.svg',
      contentType: file.mimetype || 'application/octet-stream',
    });
    if (opts.caption !== undefined) {
      form.append('caption', opts.caption);
    }
    if (opts.parse_mode) {
      form.append('parse_mode', opts.parse_mode);
    }
    if (opts.reply_to_message_id !== undefined) {
      form.append('reply_to_message_id', String(opts.reply_to_message_id));
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
      this.logger.warn(`Telegram sendDocument failed: ${JSON.stringify(data)}`);
      throw new ServiceUnavailableException(
        (data as TelegramErrResponse).description ?? 'Telegram sendDocument failed',
      );
    }
  }

  private async telegramSendMediaGroupWithCaption(
    files: UploadedAttachment[],
    captionHtml: string,
  ): Promise<void> {
    const url = `${TELEGRAM_API}/bot${this.botToken}/sendMediaGroup`;
    const mediaJson: InputMediaItem[] = [];
    const form = new FormData();
    form.append('chat_id', this.chatId);

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const attachName = `f${i}`;
      const mime = (file.mimetype || '').toLowerCase();
      const isPhoto =
        mime === 'image/png' || mime === 'image/jpeg' || mime === 'image/jpg';
      const base: InputMediaItem = isPhoto
        ? { type: 'photo', media: `attach://${attachName}` }
        : { type: 'document', media: `attach://${attachName}` };
      if (i === 0) {
        base.caption = captionHtml;
        base.parse_mode = 'HTML';
      }
      mediaJson.push(base);
      form.append(
        attachName,
        file.buffer,
        {
          filename:
            file.originalname ||
            (isPhoto ? `attachment-${i}.jpg` : `attachment-${i}.svg`),
          contentType: file.mimetype || 'application/octet-stream',
        },
      );
    }
    form.append('media', JSON.stringify(mediaJson));

    const { data } = await firstValueFrom(
      this.http.post<TelegramOkResponse | TelegramErrResponse>(url, form, {
        headers: form.getHeaders(),
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 120_000,
      }),
    );
    if (!data.ok) {
      this.logger.warn(`Telegram sendMediaGroup failed: ${JSON.stringify(data)}`);
      throw new ServiceUnavailableException(
        (data as TelegramErrResponse).description ?? 'Telegram sendMediaGroup failed',
      );
    }
  }

  private async telegramSendMediaGroupReply(
    files: UploadedAttachment[],
    replyToMessageId: number,
  ): Promise<void> {
    const url = `${TELEGRAM_API}/bot${this.botToken}/sendMediaGroup`;
    const mediaJson: InputMediaItem[] = [];
    const form = new FormData();
    form.append('chat_id', this.chatId);
    form.append('reply_to_message_id', String(replyToMessageId));

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const attachName = `f${i}`;
      const mime = (file.mimetype || '').toLowerCase();
      const isPhoto =
        mime === 'image/png' || mime === 'image/jpeg' || mime === 'image/jpg';
      mediaJson.push(
        isPhoto
          ? { type: 'photo', media: `attach://${attachName}` }
          : { type: 'document', media: `attach://${attachName}` },
      );
      form.append(
        attachName,
        file.buffer,
        {
          filename:
            file.originalname ||
            (isPhoto ? `attachment-${i}.jpg` : `attachment-${i}.svg`),
          contentType: file.mimetype || 'application/octet-stream',
        },
      );
    }
    form.append('media', JSON.stringify(mediaJson));

    const { data } = await firstValueFrom(
      this.http.post<TelegramOkResponse | TelegramErrResponse>(url, form, {
        headers: form.getHeaders(),
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 120_000,
      }),
    );
    if (!data.ok) {
      this.logger.warn(`Telegram sendMediaGroup failed: ${JSON.stringify(data)}`);
      throw new ServiceUnavailableException(
        (data as TelegramErrResponse).description ?? 'Telegram sendMediaGroup failed',
      );
    }
  }
}
