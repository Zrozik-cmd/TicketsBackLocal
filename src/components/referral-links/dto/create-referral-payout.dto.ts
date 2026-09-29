import { Type } from 'class-transformer';
import { IsNumber, IsPositive } from 'class-validator';

export class CreateReferralPayoutDto {
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  paidAmount: number;
}
