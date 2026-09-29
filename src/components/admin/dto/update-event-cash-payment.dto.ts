import { IsBoolean } from "class-validator";

export class UpdateEventCashPaymentDto {
  @IsBoolean()
  enabled!: boolean;
}
