import { Type } from 'class-transformer';
import { IsInt, IsNumber, IsOptional, IsString, Min, MinLength } from 'class-validator';

export class CheckPromoCodeForTicketDto {
  @IsString()
  @MinLength(1)
  code: string;

  @Type(() => Number)
  @IsNumber()
  @IsInt()
  @Min(1)
  eventId: number;

  /** If set, ensures this many tickets can still be bought with the code. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsInt()
  @Min(1)
  ticketCount?: number;
}
