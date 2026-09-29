import { Transform, Type } from 'class-transformer';
import { IsIn, IsNumber, IsOptional, IsString, MaxLength } from 'class-validator';
import {
  FINANCE_CURRENCIES,
  FinanceCurrency,
  PAYOUT_SOURCES,
  PAYOUT_TYPES,
  PayoutSource,
  PayoutType,
} from '../types/finance.types';

/** Пустое поле формы ("") = не передано. */
const optionalNumber = ({ value }: { value: unknown }) =>
  value === undefined || value === null || value === '' ? undefined : Number(value);

/**
 * multipart/form-data: type, amount, currency, rateToThb?, source, note?, files[].
 * Числа приходят строками — отсюда @Type/@Transform (глобальный pipe без неявной конверсии).
 */
export class CreateFinancePayoutDto {
  @IsIn(PAYOUT_TYPES, { message: 'finance_invalid_payload' })
  type: PayoutType;

  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 }, { message: 'finance_amount_invalid' })
  amount: number;

  @IsIn(FINANCE_CURRENCIES, { message: 'finance_invalid_payload' })
  currency: FinanceCurrency;

  @IsOptional()
  @Transform(optionalNumber)
  @IsNumber({ allowNaN: false, allowInfinity: false }, { message: 'finance_rate_required' })
  rateToThb?: number;

  @IsIn(PAYOUT_SOURCES, { message: 'finance_invalid_payload' })
  source: PayoutSource;

  @IsOptional()
  @IsString({ message: 'finance_invalid_payload' })
  @MaxLength(1000, { message: 'finance_note_too_long' })
  note?: string;
}
