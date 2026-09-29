import {
  Injectable,
  Logger,
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom, timeout, catchError } from 'rxjs';
import { AxiosError } from 'axios';
import type {
  CreateTransactionRequest,
  PaymentTransactionResponse,
  CreateOrderPaymentPayload,
} from './payment-microservice.types';

const PAYMENT_TIMEOUT_MS = 30000;

@Injectable()
export class PaymentMicroserviceService {
  private readonly logger = new Logger(PaymentMicroserviceService.name);
  private readonly baseUrl: string;
  private readonly clientKey: string;
  private readonly apiSecret: string;
  private readonly redirectPath: string;
  private readonly enabled: boolean;

  constructor(
    private readonly config: ConfigService,
    private readonly http: HttpService,
  ) {
    this.baseUrl = this.config.get<string>('PAYMENT_SERVICE_URL', '').replace(/\/$/, '');
    this.clientKey = this.config.get<string>('PAYMENT_CLIENT_KEY', '');
    this.apiSecret = this.config.get<string>('PAYMENT_API_SECRET', '');
    this.redirectPath = this.config.get<string>('PAYMENT_REDIRECT_PATH', '/payment/success');
    this.enabled = Boolean(this.baseUrl && this.clientKey && this.apiSecret);

    console.log('params', {
      baseUrl: this.baseUrl,
      clientKey: this.clientKey,
      apiSecret: this.apiSecret,
      redirectPath: this.redirectPath,
      enabled: this.enabled
    });
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Create a transaction in the payment microservice (ARBI).
   * Amount must be in minimal units (e.g. 100 THB = 10000).
   */
  async createTransaction(params: {
    orderId: number;
    amountInMinorUnits: number;
    currency?: string;
    outputCurrency?: string;
    description?: string;
    paymentMethod?: number;
    /** Overrides env PAYMENT_REDIRECT_PATH; ARBI Pay `return_url` = client redirectDomain + this path. */
    redirectPath?: string;
    /** Код точки ARBIPAY события (см. `metadata.storeCode`); без него — общая точка клиента. */
    storeCode?: string | null;
  }): Promise<CreateOrderPaymentPayload> {
    if (!this.enabled) {
      throw new BadRequestException(
        'Payment service is not configured (PAYMENT_SERVICE_URL, PAYMENT_CLIENT_KEY, PAYMENT_API_SECRET)',
      );
    }

    const externalId = String(params.orderId);
    const body: CreateTransactionRequest = {
      type: 'payment',
      amount: params.amountInMinorUnits,
      currency: params.currency ?? 'RUB',
      outputCurrency: params.outputCurrency ?? 'THB',
      provider: 'arbi',
      externalId,
      metadata: {
        orderId: externalId,
        description: params.description ?? `Оплата заказа #${params.orderId}`,
        paymentMethod: params.paymentMethod ?? 1,
        // Только внутри metadata: посторонние поля верхнего уровня микросервис отвергает (400).
        ...(params.storeCode ? { storeCode: params.storeCode } : {}),
      },
      redirectPath: params.redirectPath ?? this.redirectPath,
    };

    const url = `${this.baseUrl}/transactions`;
    const headers = {
      'Content-Type': 'application/json',
      'X-Client-Key': this.clientKey,
      'X-Api-Secret': this.apiSecret,
    };

    this.logger.log(
      `Creating payment transaction for order ${params.orderId} at ${url} (currency=${body.currency}, paymentMethod=${body.metadata?.paymentMethod}, storeCode=${body.metadata?.storeCode ?? '—'})`,
    );

    try {
      const response = await firstValueFrom(
        this.http.post<PaymentTransactionResponse>(url, body, { headers }).pipe(
          timeout(PAYMENT_TIMEOUT_MS),
          catchError((err: AxiosError<{ message?: string | string[] }>) => {
            const status = err.response?.status;
            const data = err.response?.data;
            const message = Array.isArray(data?.message) ? data?.message.join(', ') : data?.message ?? err.message;
            if (status === 409) {
              throw new ConflictException(
                message || `Transaction already exists for order ${params.orderId}`,
              );
            }
            if (status && status >= 400 && status < 500) {
              throw new BadRequestException(message || `Payment service error: ${status}`);
            }
            throw new ServiceUnavailableException(
              message || 'Payment service is temporarily unavailable',
            );
          }),
        ),
      );

      const tx = response.data;
      return this.toFrontendPayload(tx, params.orderId);
    } catch (e) {
      if (
        e instanceof ConflictException ||
        e instanceof BadRequestException ||
        e instanceof ServiceUnavailableException
      ) {
        throw e;
      }
      this.logger.warn(`Payment microservice request failed: ${e}`);
      throw new ServiceUnavailableException(
        'Payment service is temporarily unavailable',
      );
    }
  }

  private toFrontendPayload(
    tx: PaymentTransactionResponse,
    orderId: number,
  ): CreateOrderPaymentPayload {
    const meta = tx.metadata;
    return {
      orderId,
      paymentUrl: meta?.paymentUrl ?? null,
      cryptoWallet: meta?.cryptoWallet ?? null,
      qrLink: meta?.qrLink ?? null,
      redirectUrl: tx.redirectUrl ?? null,
      status: tx.status,
      providerTransactionId: tx.providerTransactionId ?? null,
      amount: tx.amount ?? null,
      currency: tx.currency ?? null,
      outputAmount: tx.outputAmount ?? null,
      outputCurrency: tx.outputCurrency ?? null,
      providerMetadata: meta ? { ...meta } : null,
    };
  }
}
