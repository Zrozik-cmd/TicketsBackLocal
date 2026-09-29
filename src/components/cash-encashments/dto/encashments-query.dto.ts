import { Transform, Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

function optionalQueryString(value: unknown): string | undefined {
  if (value === '' || value == null) {
    return undefined;
  }
  return typeof value === 'string' ? value : undefined;
}

const ICT_DAY = /^\d{4}-\d{2}-\d{2}$/;

export class EncashmentsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  /** ICT-день включительно, YYYY-MM-DD. */
  @IsOptional()
  @Transform(({ value }) => optionalQueryString(value))
  @IsString()
  @Matches(ICT_DAY)
  from?: string;

  /** ICT-день включительно, YYYY-MM-DD. */
  @IsOptional()
  @Transform(({ value }) => optionalQueryString(value))
  @IsString()
  @Matches(ICT_DAY)
  to?: string;

  /** Только для админа: чью историю смотреть. Кассиру всегда возвращается своя. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  cashierId?: number;
}

export class CashStatsSummaryQueryDto {
  /** Только для админа: чью статистику смотреть. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  cashierId?: number;
}
