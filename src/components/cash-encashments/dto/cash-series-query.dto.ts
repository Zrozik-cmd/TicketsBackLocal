import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { POS_STATS_PERIODS, PosStatsPeriod } from './pos-stats-query.dto';

/** Ряды для графиков статистики кассира: выручка и инкассации по времени. */
export class CashSeriesQueryDto {
  /** Только для админа: чьи графики смотреть. Кассиру подставляется он сам. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  cashierId?: number;

  @IsOptional()
  @Transform(({ value }) => (value === '' || value == null ? undefined : value))
  @IsString()
  @IsIn(POS_STATS_PERIODS)
  period?: PosStatsPeriod;
}
