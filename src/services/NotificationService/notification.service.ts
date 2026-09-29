import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { SendMailOptions } from 'nodemailer';
import axios from 'axios';
import * as qs from 'qs';

const TELEGRAM_GATEWAY_URL = 'https://gatewayapi.telegram.org/sendVerificationMessage';

type EmailOptions = {
  to: string;
  subject: string;
  text?: string;
  html?: string;
  attachments?: SendMailOptions['attachments'];
};

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);
  private mailer: nodemailer.Transporter | null = null;

  constructor(private readonly config: ConfigService) {
    this.initMailer();
  }

  private initMailer(): void { 
    const host = this.config.get<string>('SMTP_HOST');
    const portRaw = this.config.get<string>('SMTP_PORT');
    const port = portRaw ? parseInt(portRaw, 10) : 587;
    const user = this.config.get<string>('SMTP_USER');
    const pass = this.config.get<string>('SMTP_PASS');
    const secure = true

    console.log('initMailer', {
      host,
      portRaw,
      port,
      user,
      pass,
      secure,
    });

    console.log({host, port, user, pass})
    if (host && user && pass) {
      this.mailer = nodemailer.createTransport({
        host,
        port: Number.isNaN(port) ? 587 : port,
        secure,
        auth: { user, pass },
      });
      this.logger.log(`SMTP transporter initialized (${host}:${port})`);
    } else {
      this.logger.warn(
        'SMTP not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS in .env. Email codes will only be logged.',
      );
    }
  }

  /** При старте вывести, какие каналы уведомлений настроены. */
  logNotificationStatus(): void {
    const hasSmtp = !!this.mailer;
    const hasTg = !!this.config.get<string>('TELEGRAM_GATEWAY_ACCESS_TOKEN');
    const hasSms =
      !!this.config.get<string>('THAIBULKSMS_API_KEY') &&
      !!this.config.get<string>('THAIBULKSMS_API_SECRET') &&
      !!this.config.get<string>('THAIBULKSMS_SENDER'); 
    this.logger.log(
      `Notifications: Email(SMTP)=${hasSmtp ? 'yes' : 'no'}, Telegram=${hasTg ? 'yes' : 'no'}, ThaiBulkSMS=${hasSms ? 'yes' : 'no'}`,
    );
  }

  /**
   * Отправка кода на email через nodemailer. 
   */
  async sendEmailVerificationCode(email: string, code: string): Promise<void> {
    const subject = this.config.get<string>('SMTP_CODE_SUBJECT') ?? 'Your verification code';
    const text = `Your verification code is: ${code}`;
    const html = this.config.get<string>('SMTP_CODE_HTML')
      ?.replace(/\{code\}/g, code)
      ?? `<p>Your verification code is: <strong>${code}</strong></p>`;
    await this.sendEmail({
      to: email,
      subject,
      text,
      html,
    });
    this.logger.log(`Email code sent to ${email} - ${code}`);
  }

  /** Никогда не бросает: ошибка SMTP только логируется. */
  async sendEmail(options: EmailOptions): Promise<void> {
    try {
        await this.sendEmailOrThrow(options);
    } catch (error) {
        console.log("error", error);
    }
  }

  /**
   * То же, что `sendEmail`, но ошибка SMTP долетает до вызывающего — для отправок,
   * которые сами ведут учёт «отправлено» и повторяют попытки. Без настроенного SMTP
   * письмо, как и в `sendEmail`, только логируется.
   */
  async sendEmailOrThrow(options: EmailOptions): Promise<void> {
    const from = this.config.get<string>('SMTP_FROM') ?? this.config.get<string>('SMTP_USER') ?? 'noreply@arbitickets.com';
    if (this.mailer) {
      try {
        const res = await this.mailer.sendMail({
          from,
          to: options.to,
          subject: options.subject,
          text: options.text,
          html: options.html,
          attachments: options.attachments,
        });
        console.log("res", res);
      } catch (err: unknown) {
        this.logger.error(`Send email to ${options.to} failed:`, err instanceof Error ? err.message : err);
        throw err;
      }
      return;
    }
    this.logger.log(`[MOCK] Send email to ${options.to}: ${options.subject}`);
  }

  /**
   * Отправка кода на телефон: сначала Telegram Gateway, при неудаче — ThaiBulkSMS.
   */
  async sendPhoneVerificationCode(phone: string, code: string): Promise<void> {
    const normalized = phone.startsWith('+') ? phone.replace("+", "") : phone;

    const sentViaTelegram = await this.sendViaTelegram(normalized, code); 
    if (sentViaTelegram) {
      this.logger.log(`Phone code sent via Telegram to ${normalized} - ${code}`);
      return; 
    } 

    const sentViaSms = await this.sendViaThaiBulkSMS(normalized, code);
    if (sentViaSms) {
      this.logger.log(`Phone code sent via ThaiBulkSMS to ${normalized} - ${code}`);
      return;
    }

    this.logger.warn(`Neither Telegram nor SMS succeeded for ${normalized}; logging code: ${code}`);
  }

  private async sendViaTelegram(phoneE164: string, code: string): Promise<boolean> {
    const token = this.config.get<string>('TELEGRAM_GATEWAY_ACCESS_TOKEN');
    if (!token) {
      this.logger.warn('TELEGRAM_GATEWAY_ACCESS_TOKEN not set in .env — add token from https://gateway.telegram.org/account/api');
      return false;
    }

    try {
      const resp = await axios.post(
        TELEGRAM_GATEWAY_URL,
        qs.stringify({ phone_number: phoneE164, code }),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
            Authorization: `Bearer ${token}`,
          },
          timeout: 10000,
        },
      );
      const ok = resp.data?.ok === true;
      if (!ok) {
        this.logger.warn('Telegram Gateway response not ok:', resp.data);
      }
      return ok;
    } catch (err: unknown) {
      if (axios.isAxiosError(err)) {
        const status = err.response?.status;
        const data = err.response?.data;
        this.logger.warn(
          `Telegram Gateway failed for ${phoneE164} status=${status} data=${JSON.stringify(data)}`,
        );
      } else {
        this.logger.warn(`Telegram Gateway failed for ${phoneE164}:`, (err as Error).message);
      }
      return false;
    }
  }

  private async sendViaThaiBulkSMS(to: string, body: string): Promise<boolean> {
    const apiKey = this.config.get<string>('THAIBULKSMS_API_KEY'); 
    const apiSecret = this.config.get<string>('THAIBULKSMS_API_SECRET');
    const sender = this.config.get<string>('THAIBULKSMS_SENDER');
    const apiUrl = this.config.get<string>('THAIBULKSMS_API_URL') ?? 'https://api-v2.thaibulksms.com/sms';
    console.log("apiKey", apiKey, "apiSecret", apiSecret, "sender", sender);
    if (!apiKey || !apiSecret || !sender) {
      this.logger.warn('ThaiBulkSMS not configured: set THAIBULKSMS_API_KEY, THAIBULKSMS_API_SECRET, THAIBULKSMS_SENDER in .env');
      return false;
    }
    console.log("send sms to", to, "body", body);
    try {
      const data = qs.stringify({
        msisdn: to,
        message: body,
        sender,
      });
      const authString = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');

      const resp = await axios.post(apiUrl, data, {
        headers: { 
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          Authorization: `Basic ${authString}`,
        },
        timeout: 10000,
      });

      const ok = resp.data?.ok !== false && (resp.status === 200 || resp.data?.status === 'success');
      if (!ok) {
        this.logger.warn('ThaiBulkSMS response not ok:', resp.data);
      }
      return ok;
    } catch (err: unknown) {
      const msg = axios.isAxiosError(err) ? err.response?.data ?? err.message : (err as Error).message;
      this.logger.error('ThaiBulkSMS send error:', msg);
      return false;
    }
  }
}
