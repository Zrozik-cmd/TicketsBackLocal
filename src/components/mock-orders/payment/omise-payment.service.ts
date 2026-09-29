import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { AxiosError } from 'axios';
import { catchError, firstValueFrom, timeout } from 'rxjs';
import type {
  OmiseChargeResponse,
  OmisePaymentMethod,
} from './omise-payment.types';
import type { CreateOrderPaymentPayload } from './payment-microservice.types';

const OMISE_API_BASE_URL = 'https://api.omise.co';
const OMISE_TIMEOUT_MS = 30000;

@Injectable()
export class OmisePaymentService implements OnModuleInit {
  private readonly logger = new Logger(OmisePaymentService.name);
  private readonly publicKey: string;
  private readonly secretKey: string;
  private readonly enabled: boolean;

  constructor(
    private readonly config: ConfigService,
    private readonly http: HttpService,
  ) {
    this.publicKey = this.config.get<string>('OMISE_PUBLIC_KEY', '').trim();
    this.secretKey = this.config.get<string>('OMISE_SECRET_KEY', '').trim();
    this.enabled = Boolean(this.publicKey && this.secretKey);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.warn('[Omise] Disabled (OMISE_PUBLIC_KEY / OMISE_SECRET_KEY missing)');
      return;
    }
    await this.logSupportedPaymentMethods();
  }

  /**
   * Logs the payment methods (= valid `source[type]` names) enabled for this Omise
   * account, so misconfigured methods like Alipay are easy to diagnose.
   */
  private async logSupportedPaymentMethods(): Promise<void> {
    try {
      const response = await firstValueFrom(
        this.http
          .get<{ payment_methods?: Array<{ name?: string; currencies?: string[] }> }>(
            `${OMISE_API_BASE_URL}/capability`,
            { headers: this.authHeaders() },
          )
          .pipe(timeout(OMISE_TIMEOUT_MS)),
      );
      const methods = response.data?.payment_methods ?? [];
      const names = methods
        .map((m) => m.name)
        .filter((name): name is string => typeof name === 'string' && name.length > 0);
      this.logger.log(`[Omise] Supported payment methods (${names.length}): ${names.join(', ') || 'none'}`);
      const alipayLike = names.filter((name) => name.includes('alipay'));
      this.logger.log(
        `[Omise] Alipay-family source types: ${alipayLike.length ? alipayLike.join(', ') : 'NONE — Alipay is not enabled in the Omise dashboard'}`,
      );
    } catch (e) {
      this.logger.warn(`[Omise] Failed to fetch capability: ${(e as Error).message}`);
    }
  }

  async createCharge(params: {
    orderId: number;
    amountInMinorUnits: number;
    method: OmisePaymentMethod;
    cardToken?: string;
    description?: string;
    returnUri?: string;
  }): Promise<CreateOrderPaymentPayload> {
    if (!this.enabled) {
      throw new BadRequestException(
        'Omise is not configured (OMISE_PUBLIC_KEY, OMISE_SECRET_KEY)',
      );
    }

    const charge = await this.createOmiseCharge(params);
    return this.toFrontendPayload(charge, params.orderId, params.method);
  }

  async retrieveCharge(chargeId: string): Promise<OmiseChargeResponse> {
    if (!this.enabled) {
      throw new BadRequestException(
        'Omise is not configured (OMISE_PUBLIC_KEY, OMISE_SECRET_KEY)',
      );
    }

    const response = await firstValueFrom(
      this.http
        .get<OmiseChargeResponse>(`${OMISE_API_BASE_URL}/charges/${chargeId}`, {
          headers: this.authHeaders(),
        })
        .pipe(timeout(OMISE_TIMEOUT_MS), catchError((err) => this.handleOmiseError(err))),
    );

    return response.data;
  }

  private async createOmiseCharge(params: {
    orderId: number;
    amountInMinorUnits: number;
    method: OmisePaymentMethod;
    cardToken?: string;
    description?: string;
    returnUri?: string;
  }): Promise<OmiseChargeResponse> {
    const body = new URLSearchParams();
    body.set('amount', String(params.amountInMinorUnits));
    body.set('currency', 'thb');
    body.set('description', params.description ?? `Payment for order #${params.orderId}`);
    body.set('metadata[orderId]', String(params.orderId));
    body.set('metadata[paymentProvider]', 'omise');
    body.set('metadata[paymentMethod]', params.method);

    if (params.returnUri) {
      body.set('return_uri', params.returnUri);
    }

    let sourceType = 'card';
    if (params.method === 'card') {
      const token = params.cardToken?.trim();
      if (!token) {
        throw new BadRequestException('Omise card token is required');
      }
      body.set('card', token);
    } else {
      sourceType = this.resolveOmiseSourceType(params.method);
      body.set('source[type]', sourceType);
      body.set('source[amount]', String(params.amountInMinorUnits));
      body.set('source[currency]', 'thb');
      if (params.method === 'promptpay') {
        body.set('source[qr_settings][image_type]', 'png');
      }
    }

    this.logger.log(
      `[Omise] Creating charge order=${params.orderId} method=${params.method} sourceType=${sourceType} ` +
        `amount=${params.amountInMinorUnits} satang returnUri=${params.returnUri ?? 'none'}`,
    );

    const response = await firstValueFrom(
      this.http
        .post<OmiseChargeResponse>(`${OMISE_API_BASE_URL}/charges`, body.toString(), {
          headers: {
            ...this.authHeaders(),
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        })
        .pipe(timeout(OMISE_TIMEOUT_MS), catchError((err) => this.handleOmiseError(err))),
    );

    const charge = response.data;
    this.logger.log(
      `[Omise] Charge created order=${params.orderId} chargeId=${charge.id} status=${charge.status} ` +
        `authorizeUri=${charge.authorize_uri ? 'yes' : 'no'} ` +
        `qr=${charge.source?.scannable_code?.image?.download_uri ? 'yes' : 'no'} ` +
        `failureCode=${charge.failure_code ?? 'none'} failureMessage=${charge.failure_message ?? 'none'}`,
    );

    return charge;
  }

  /**
   * Maps our internal method to a valid Omise source `type`.
   *
   * Plain `alipay` is the in-store barcode source and is rejected ("source type is
   * not valid") for the offsite redirect flow we use. Omise's offsite Alipay wallets
   * are `alipay_cn` (mainland) and `alipay_hk`. The exact one must be enabled in the
   * Omise dashboard; override via `OMISE_ALIPAY_SOURCE_TYPE` if the account uses another.
   */
  private resolveOmiseSourceType(method: OmisePaymentMethod): string {
    if (method === 'alipay') {
      const configured = this.config
        .get<string>('OMISE_ALIPAY_SOURCE_TYPE', '')
        .trim();
      return configured || 'alipay_cn';
    }
    return method;
  }

  private toFrontendPayload(
    charge: OmiseChargeResponse,
    orderId: number,
    method: OmisePaymentMethod,
  ): CreateOrderPaymentPayload {
    const qrImageUrl =
      charge.source?.scannable_code?.image?.download_uri ??
      charge.source?.scannable_code?.image?.uri ??
      null;
    const authorizeUri = charge.authorize_uri ?? null;

    // Diagnostics for the PromptPay QR flow: shows exactly what we hand to the
    // frontend and the raw Omise `source` when the QR image is missing.
    this.logger.log(
      `[Omise] toFrontendPayload order=${orderId} method=${method} status=${charge.status} ` +
        `qrLink=${qrImageUrl ? 'present' : 'MISSING'} authorizeUri=${authorizeUri ? 'present' : 'none'}`,
    );
    if (method === 'promptpay' && !qrImageUrl) {
      this.logger.warn(
        `[Omise] PromptPay QR missing for order=${orderId}. Raw source=${JSON.stringify(charge.source ?? null)}`,
      );
    }

    return {
      orderId,
      paymentUrl: authorizeUri,
      cryptoWallet: null,
      qrLink: qrImageUrl,
      redirectUrl: authorizeUri,
      status: charge.status,
      providerTransactionId: charge.id,
      amount: charge.amount ?? null,
      currency: charge.currency?.toUpperCase?.() ?? 'THB',
      outputAmount: charge.amount ?? null,
      outputCurrency: charge.currency?.toUpperCase?.() ?? 'THB',
      providerMetadata: {
        provider: 'omise',
        omisePaymentMethod: method,
        omiseChargeId: charge.id,
        omiseSourceId: charge.source?.id ?? null,
        authorizeUri,
        qrImageUrl,
        failureCode: charge.failure_code ?? null,
        failureMessage: charge.failure_message ?? null,
      },
    };
  }

  private authHeaders(): Record<string, string> {
    return {
      Authorization: `Basic ${Buffer.from(`${this.secretKey}:`).toString('base64')}`,
    };
  }

  private handleOmiseError(err: AxiosError<{ message?: string; code?: string }>): never {
    const status = err.response?.status;
    const data = err.response?.data;
    const message = data?.message ?? err.message;
    // Log the full Omise error for every failure (4xx included) so payment
    // rejections like "source type is not valid" are visible in the logs.
    this.logger.error(
      `[Omise] API error status=${status ?? 'n/a'} code=${data?.code ?? 'n/a'} ` +
        `message=${message} body=${JSON.stringify(data ?? {})}`,
    );
    if (status && status >= 400 && status < 500) {
      throw new BadRequestException(message || `Omise API error: ${status}`);
    }
    throw new ServiceUnavailableException(
      message || 'Omise payment service is temporarily unavailable',
    );
  }
}
