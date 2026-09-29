import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString } from 'class-validator';

export const POS_STATS_PERIODS = [
  'today',
  'days7',
  'days30',
  'days180',
  'days365',
  'all',
] as const;
export type PosStatsPeriod = (typeof POS_STATS_PERIODS)[number];

export class PosStatsQueryDto {
  @IsOptional()
  @Transform(({ value }) => (value === '' || value == null ? undefined : value))
  @IsString()
  @IsIn(POS_STATS_PERIODS)
  period?: PosStatsPeriod;
}
