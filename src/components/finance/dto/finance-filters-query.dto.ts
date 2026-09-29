import { Allow, IsOptional } from 'class-validator';

/**
 * Фильтры доски: `currencies=THB,RUB&provider=cash&from=YYYY-MM-DD&to=YYYY-MM-DD`.
 * Поля только разрешены (whitelist) — разбор и ошибка `finance_invalid_filter`
 * в parseFinanceFilter, чтобы фронт получал один код, а не тексты class-validator.
 */
export class FinanceFiltersQueryDto {
  @IsOptional()
  @Allow()
  currencies?: string | string[];

  @IsOptional()
  @Allow()
  provider?: string;

  @IsOptional()
  @Allow()
  from?: string;

  @IsOptional()
  @Allow()
  to?: string;
}
