import { Type } from 'class-transformer';
import { IsInt, IsNumber, IsOptional, Max, Min } from 'class-validator';

export class ChangeEventFeePercentsDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  eventId!: number;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  vatPercent!: number;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  processingFeePercent!: number;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  platformFeePercent!: number;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  additionalTicketCostFeePercent!: number;

  /** Комиссия за наличные. Необязательное: старый клиент просто не меняет её. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  cashFeePercent?: number;
}
