import { Transform, Type } from 'class-transformer';
import { IsEmail, IsIn, IsInt, IsOptional, Min } from 'class-validator';

function parseOrderId(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().replace(/^#/, '');
    const parsed = Number(normalized);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return value as number;
}

export class AdminResendOrderTicketsDto {
  @Transform(({ value }) => parseOrderId(value))
  @Type(() => Number)
  @IsInt()
  @Min(1)
  orderId!: number;

  @IsEmail()
  email!: string;

  @IsOptional()
  @IsIn(['en', 'ru', 'th'], {
    message: 'locale must be en, ru or th',
  })
  locale?: 'en' | 'ru' | 'th';
}
