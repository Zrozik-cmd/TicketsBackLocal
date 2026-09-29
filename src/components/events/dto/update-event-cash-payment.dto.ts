import { IsBoolean, IsDefined } from 'class-validator';

/** `PATCH /events/:id/cash-payment`: `true` turns cash payment on, `false` off. */
export class UpdateEventCashPaymentDto {
  @IsDefined()
  @IsBoolean()
  enabled: boolean;
}
