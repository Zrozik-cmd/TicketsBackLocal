import { IsString, IsOptional, IsNumber, IsObject, ValidateIf } from 'class-validator';

/**
 * Webhook payload from payment microservice (POST to webhookUrl).
 * ARBIPAY → микросервис → твой бэк.
 */
export class PaymentMicroserviceWebhookDto {
  @IsString()
  provider: string;

  @IsOptional()
  @IsString()
  transactionId?: string;

  /** Id транзакции у провайдера (ARBIPAY) */
  @IsOptional()
  @IsString()
  providerTransactionId?: string;

  /** Id заказа в нашей системе (число в виде строки, напр. "123", или UUID) */
  @IsString()
  externalId: string;

  /** completed | failed | ... */
  @IsString()
  status: string;

  @IsOptional()
  @IsString()
  paymentStatus?: string;

  @IsOptional()
  @IsNumber()
  amount?: number;

  @IsOptional()
  @IsString()
  currency?: string;

  @IsOptional()
  @ValidateIf((_, v) => v != null)
  @IsString()
  paymentLink?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v != null)
  @IsString()
  qrLink?: string | null;

  /** Адрес кошелька для крипто-оплаты (если не крипто — null) */
  @IsOptional()
  @ValidateIf((_, v) => v != null)
  @IsString()
  cryptoWallet?: string | null;

  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown>;
}
