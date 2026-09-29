import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

function optionalQueryString(value: unknown): string | undefined {
  if (value === '' || value == null) {
    return undefined;
  }
  return typeof value === 'string' ? value : undefined;
}

export class ScansQueryDto {
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

  /** Те же периоды, что в сводке выручки. */
  @IsOptional()
  @Transform(({ value }) => optionalQueryString(value))
  @IsString()
  @IsIn(['today', 'days7', 'days30', 'all'])
  period?: 'today' | 'days7' | 'days30' | 'all';

  /** Только для админа: чей журнал смотреть. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  cashierId?: number;
}
