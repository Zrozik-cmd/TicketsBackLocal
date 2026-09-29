import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { PAYOUT_SOURCES, PayoutSource } from '../types/finance.types';

/** multipart/form-data: source, note?, files[]? — провести запрос организатора. */
export class CompleteFinancePayoutDto {
  @IsIn(PAYOUT_SOURCES, { message: 'finance_invalid_payload' })
  source: PayoutSource;

  @IsOptional()
  @IsString({ message: 'finance_invalid_payload' })
  @MaxLength(1000, { message: 'finance_note_too_long' })
  note?: string;
}
