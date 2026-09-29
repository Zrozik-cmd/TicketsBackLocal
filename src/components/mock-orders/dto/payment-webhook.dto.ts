import { IsNumber } from 'class-validator';

export class PaymentWebhookDto {
  /** Numeric id of the mock order to confirm as paid */
  @IsNumber()
  orderId: number;
}
