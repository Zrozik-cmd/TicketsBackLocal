import { Transform, Type } from 'class-transformer';
import { IsInt, IsOptional, Matches, Min } from 'class-validator';
import { ICT_DAY_PATTERN } from '../utils/session-period-filter.util';

function optionalQueryString(value: unknown): string | undefined {
  if (value === '' || value == null) {
    return undefined;
  }
  return typeof value === 'string' ? value.trim() : undefined;
}

/**
 * Optional statistics filter by show date (inclusive ICT days, applied to the SESSION
 * date of a ticket) and/or one session. Absent params = the unfiltered output, exactly
 * as before. `from` after `to` is rejected by the service with 400 `invalid_date_range`.
 */
export class SessionPeriodFilterQueryDto {
  @IsOptional()
  @Transform(({ value }) => optionalQueryString(value))
  @Matches(ICT_DAY_PATTERN, { message: 'from must be a YYYY-MM-DD date' })
  from?: string;

  @IsOptional()
  @Transform(({ value }) => optionalQueryString(value))
  @Matches(ICT_DAY_PATTERN, { message: 'to must be a YYYY-MM-DD date' })
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  sessionId?: number;
}
