import { Type } from 'class-transformer';
import { IsInt, IsNumber, Max, Min } from 'class-validator';

export class ChangeUserDefaultFeePercentsDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  userId!: number;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  defaultVatPercent!: number;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  defaultProcessingFeePercent!: number;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  defaultPlatformFeePercent!: number;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  defaultAdditionalTicketCostFeePercent!: number;
}
