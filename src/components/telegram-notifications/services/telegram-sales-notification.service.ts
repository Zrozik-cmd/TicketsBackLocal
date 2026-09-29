import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import mongoose from 'mongoose';
import { CustomersService } from '../../customers/customers.service';
import { EventsService } from '../../events/events.service';
import {
  IEvent,
  ILocalizedText,
  IZone,
} from '../../events/schemas/event.schema';
import {
  IMockOrder,
  IMockOrderTicket,
  MockOrderSchema,
} from '../../mock-orders/schemas/mock-order.schema';
import {
  CheckValidationSchema,
  ICheckValidation,
} from '../../check-validation/schemas/check.schema';
import { TELEGRAM_SALES_NOTIFICATION_TIMEZONE } from '../constants/telegram.constants';
import {
  ITelegramNotificationLog,
  TelegramNotificationLogSchema,
} from '../schemas/telegram-notification-log.schema';
import {
  ITelegramUser,
  TelegramUserSchema,
} from '../schemas/telegram-user.schema';
import {
  IUserTelegramUser,
  UserTelegramUserSchema,
} from '../schemas/user-telegram-user.schema';
import { TelegramApiService } from './telegram-api.service';

type SaleRecipient = {
  linkId: number;
  telegramUserId: number;
  chatId: string;
};

@Injectable()
export class TelegramSalesNotificationService implements OnModuleInit {
  private readonly logger = new Logger(TelegramSalesNotificationService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly telegramApi: TelegramApiService,
    private readonly eventsService: EventsService,
    private readonly customersService: CustomersService,
  ) {}

  onModuleInit(): void {
    const baseUrl = this.getFrontendBaseUrl();
    this.logger.log(`PUBLIC_FRONTEND_URL resolved to: ${baseUrl || '(empty)'}`);
  }

  private get mockOrderModel(): mongoose.Model<IMockOrder> {
    return (mongoose.models.MockOrder as mongoose.Model<IMockOrder>) ??
      mongoose.model<IMockOrder>('MockOrder', MockOrderSchema);
  }

  private get userTelegramUserModel(): mongoose.Model<IUserTelegramUser> {
    return (mongoose.models.UserTelegramUser as mongoose.Model<IUserTelegramUser>) ??
      mongoose.model<IUserTelegramUser>('UserTelegramUser', UserTelegramUserSchema);
  }

  private get telegramUserModel(): mongoose.Model<ITelegramUser> {
    return (mongoose.models.TelegramUser as mongoose.Model<ITelegramUser>) ??
      mongoose.model<ITelegramUser>('TelegramUser', TelegramUserSchema);
  }

  private get notificationLogModel(): mongoose.Model<ITelegramNotificationLog> {
    return (mongoose.models.TelegramNotificationLog as mongoose.Model<ITelegramNotificationLog>) ??
      mongoose.model<ITelegramNotificationLog>(
        'TelegramNotificationLog',
        TelegramNotificationLogSchema,
      );
  }

  private get checkValidationModel(): mongoose.Model<ICheckValidation> {
    return (mongoose.models.CheckValidation as mongoose.Model<ICheckValidation>) ??
      mongoose.model<ICheckValidation>('CheckValidation', CheckValidationSchema);
  }

  async sendOrderSaleNotification(orderId: number): Promise<void> {
    if (!this.telegramApi.isConfigured()) {
      this.logger.warn('TELEGRAM_BOT_TOKEN missing; skipping sale notification');
      return;
    }

    const order = await this.mockOrderModel.findOne({ id: orderId }).lean().exec();
    if (!order || order.status !== 'paid') {
      return;
    }

    const event = await this.eventsService.findOneByNumericId(order.event);
    const recipients = await this.findConnectedRecipients(event.creator);
    if (recipients.length === 0) {
      return;
    }

    const customer = await this.customersService.findById(String(order.customer));
    const { text: message, linkPreviewUrl } = this.buildSaleMessage(order, event, customer);
    const receipt = await this.findReceiptForOrder(order);

    for (const recipient of recipients) {
      await this.sendToRecipient(orderId, recipient, message, linkPreviewUrl, receipt);
    }
  }

  private async findConnectedRecipients(creatorUserId: number): Promise<SaleRecipient[]> {
    const links = await this.userTelegramUserModel
      .find({ userId: creatorUserId, notificationsEnabled: true })
      .lean()
      .exec();
    if (links.length === 0) {
      return [];
    }

    const telegramUserIds = links.map((link) => link.telegramUserId);
    const telegramUsers = await this.telegramUserModel
      .find({
        id: { $in: telegramUserIds },
        status: 'connected',
        chatId: { $exists: true, $nin: [null, ''] },
      })
      .lean()
      .exec();
    const telegramUserById = new Map(telegramUsers.map((item) => [item.id, item]));

    const recipients: SaleRecipient[] = [];
    for (const link of links) {
      const telegramUser = telegramUserById.get(link.telegramUserId);
      if (!telegramUser?.chatId) {
        continue;
      }
      recipients.push({
        linkId: link.id,
        telegramUserId: telegramUser.id,
        chatId: telegramUser.chatId,
      });
    }
    return recipients;
  }

  private async sendToRecipient(
    orderId: number,
    recipient: SaleRecipient,
    message: string,
    linkPreviewUrl: string,
    receipt: { buffer: Buffer; mimeType: string } | null,
  ): Promise<void> {
    const alreadySent = await this.notificationLogModel
      .exists({ orderId, telegramUserId: recipient.telegramUserId, status: 'sent' })
      .exec();
    if (alreadySent) {
      return;
    }

    try {
      await this.telegramApi.sendMessage(recipient.chatId, message, {
        parseMode: 'HTML',
        linkPreview: {
          url: linkPreviewUrl,
          preferSmallMedia: true,
          showAboveText: false,
        },
      });
      if (receipt) {
        await this.sendReceipt(recipient.chatId, receipt);
      }
      await this.notificationLogModel.create({
        orderId,
        telegramUserId: recipient.telegramUserId,
        chatId: recipient.chatId,
        status: 'sent',
        sentAt: new Date(),
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      await this.notificationLogModel.create({
        orderId,
        telegramUserId: recipient.telegramUserId,
        chatId: recipient.chatId,
        status: 'failed',
        errorMessage,
      });
      this.logger.warn(
        `Telegram sale notification failed order=${orderId} telegramUser=${recipient.telegramUserId}: ${errorMessage}`,
      );
    }
  }

  private async sendReceipt(
    chatId: string,
    receipt: { buffer: Buffer; mimeType: string },
  ): Promise<void> {
    const mime = (receipt.mimeType || '').toLowerCase();
    const isPhoto = mime.startsWith('image/');
    const filename = isPhoto ? 'receipt.jpg' : 'receipt.pdf';
    if (isPhoto) {
      await this.telegramApi.sendPhotoFromBuffer(
        chatId,
        receipt.buffer,
        mime,
        filename,
        'Чек оплаты',
      );
      return;
    }
    await this.telegramApi.sendDocumentFromBuffer(
      chatId,
      receipt.buffer,
      mime,
      filename,
      'Чек оплаты',
    );
  }

  private async findReceiptForOrder(
    order: IMockOrder,
  ): Promise<{ buffer: Buffer; mimeType: string } | null> {
    const check = await this.checkValidationModel
      .findOne({ orderId: order.id, status: 'approved' })
      .select('file mimeType')
      .sort({ createdAt: -1 })
      .lean()
      .exec();
    if (!check?.file?.length) {
      return null;
    }
    return { buffer: check.file, mimeType: check.mimeType || 'application/octet-stream' };
  }

  private buildSaleMessage(
    order: IMockOrder,
    event: IEvent,
    customer: Awaited<ReturnType<CustomersService['findById']>>,
  ): { text: string; linkPreviewUrl: string } {
    const amount = this.formatAmount(order.total_price);
    const paymentMethod = this.formatPaymentMethod(order);
    const paidAt = this.formatPaidAt(order.updatedAt ?? order.createdAt);
    const eventTitle = this.pickLocalizedText(event.title, `Event #${event.id}`);
    const ticketLines = this.formatTicketLinesHtml(order.tickets ?? [], event);
    // Locale prefix is required since the frontend moved to /{locale}/... —
    // without it the link bounces through a language-detection redirect and
    // Telegram (which sends no language header) would preview it in English
    // under an otherwise Russian notification. The id-only slug still
    // redirects once to the canonical spelling, which is fine for a preview.
    const eventUrl = `${this.getFrontendBaseUrl()}/ru/events/${event.id}`;

    const paymentBlock = [
      this.htmlLine('Сумма:', amount),
      this.htmlLine('Способ оплаты:', paymentMethod),
      this.htmlLine('Время:', paidAt),
      this.htmlLine('ID заказа:', String(order.id)),
    ].join('\n');

    const eventBlock = [
      this.htmlLine('Событие:', eventTitle),
      'Билеты:',
      ticketLines,
    ].join('\n');

    const customerLines = [
      this.htmlLine('Имя заказчика:', customer?.fullname?.trim() || 'не указано'),
    ];
    if (customer?.email?.trim()) {
      customerLines.push(this.htmlLine('email:', customer.email.trim()));
    }
    if (customer?.phone?.trim()) {
      customerLines.push(this.htmlLine('Телефон:', customer.phone.trim()));
    }

    const linkBlock = ['Ссылка на событие:', this.escapeHtml(eventUrl)].join('\n');

    return {
      text: [
        '💸 Новая продажа билетов',
        '',
        this.htmlBlockquote(paymentBlock),
        '',
        this.htmlBlockquote(eventBlock),
        '',
        this.htmlBlockquote(customerLines.join('\n')),
        '',
        linkBlock,
      ].join('\n'),
      linkPreviewUrl: eventUrl,
    };
  }

  private htmlBlockquote(content: string): string {
    return `<blockquote>${content}</blockquote>`;
  }

  private htmlLine(label: string, value: string): string {
    return `${label} <b>${this.escapeHtml(value)}</b>`;
  }

  private escapeHtml(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  private formatTicketLinesHtml(tickets: IMockOrderTicket[], event: IEvent): string {
    if (!tickets.length) {
      return `<b>${this.escapeHtml('не указаны')}</b>`;
    }

    return tickets
      .map((ticket) => {
        const label = this.resolveTicketLabel(ticket, event);
        return `<b>${this.escapeHtml(`${label} х ${ticket.count} шт`)}</b>`;
      })
      .join('\n');
  }

  private resolveTicketLabel(ticket: IMockOrderTicket, event: IEvent): string {
    const sector = event.sectors?.find((item) => item.id === ticket.sectorId);
    const zone = sector?.zones?.find((item: IZone) => item.id === ticket.zoneId);
    const zoneName = this.pickLocalizedText(zone?.name, ticket.zoneId);
    if (zoneName && zoneName !== ticket.zoneId) {
      return zoneName;
    }
    const sectorName = this.pickLocalizedText(sector?.name, ticket.sectorId);
    return sectorName || `${ticket.sectorId}/${ticket.zoneId}`;
  }

  private pickLocalizedText(value: ILocalizedText | undefined, fallback: string): string {
    if (!value) {
      return fallback;
    }
    for (const key of ['ru', 'en', 'th'] as const) {
      const text = value[key]?.trim();
      if (text) {
        return text;
      }
    }
    return fallback;
  }

  private formatPaidAt(date: Date): string {
    return date.toLocaleString('ru-RU', {
      timeZone: TELEGRAM_SALES_NOTIFICATION_TIMEZONE,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  }

  /** Order `total_price` is always stored in THB (ticket currency), not in `paymentCurrency`. */
  private formatAmount(amount: number): string {
    const formatted = amount.toLocaleString('ru-RU', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    return `${formatted} THB`;
  }

  private formatPaymentMethod(order: IMockOrder): string {
    switch (order.paymentMethod) {
      case 'CASH':
        return 'Наличные';
      case 'ALIPAY':
        return 'Alipay';
      case 'CARD':
        return 'Банковская карта (Omise)';
      case 'QR':
        return 'Thai QR (PromptPay)';
      default:
        break;
    }
    switch (order.paymentCurrency) {
      case 'THB':
        return 'Thai QR';
      case 'RUB':
        return 'SBP';
      case 'USDT':
        return 'USDT';
      case 'KZT':
        return 'KZT';
      default:
        return order.paymentCurrency;
    }
  }

  private getFrontendBaseUrl(): string {
    const configured = this.config.get<string>('PUBLIC_FRONTEND_URL', '').trim();
    if (configured) {
      return configured.replace(/\/+$/, '');
    }

    const nodeEnv = (this.config.get<string>('NODE_ENV', 'development') ?? 'development')
      .trim()
      .toLowerCase();

    if (nodeEnv !== 'production') {
      this.logger.warn(
        'PUBLIC_FRONTEND_URL is not set; using https://tickets.diil.me for Telegram event links',
      );
      return 'https://tickets.diil.me';
    }

    this.logger.error(
      'PUBLIC_FRONTEND_URL is not set in production; Telegram event links will be invalid',
    );
    return '';
  }
}
