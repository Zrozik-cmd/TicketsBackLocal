import { Type } from 'class-transformer';
import { IsInt, IsString, MaxLength, Min, MinLength } from 'class-validator';

export class ScanTicketDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  eventId: number;

  @IsString()
  @MinLength(3)
  @MaxLength(64)
  code: string;
}
