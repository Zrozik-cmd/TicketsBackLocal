import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export const CASH_ORDERS_SCOPES = ['own', 'all'] as const;
export type CashOrdersScope = (typeof CASH_ORDERS_SCOPES)[number];

function optionalQueryString(value: unknown): string | undefined {
  if (value === '' || value == null) {
    return undefined;
  }
  return typeof value === 'string' ? value : undefined;
}

export class CashOrdersQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  limit?: number;

  @IsOptional()
  @Transform(({ value }) => optionalQueryString(value))
  @IsString()
  orderId?: string;

  @IsOptional()
  @Transform(({ value }) => optionalQueryString(value))
  @IsString()
  email?: string;

  @IsOptional()
  @Transform(({ value }) => optionalQueryString(value))
  @IsString()
  customerName?: string;

  @IsOptional()
  @Transform(({ value }) => optionalQueryString(value))
  @IsString()
  pos?: string;

  @IsOptional()
  @Transform(({ value }) => optionalQueryString(value))
  @IsIn(['pending_cash', 'paid', 'expired', 'cancelled'])
  status?: 'pending_cash' | 'paid' | 'expired' | 'cancelled';

  /**
   * Охват списка для кассира: 'own' (по умолчанию) — только своя точка,
   * pos из query игнорируется; 'all' — все точки, pos фильтрует как у админа.
   * Для админа игнорируется — он всегда видит все точки.
   */
  @IsOptional()
  @Transform(({ value }) => optionalQueryString(value))
  @IsIn(CASH_ORDERS_SCOPES)
  scope?: CashOrdersScope;
}
