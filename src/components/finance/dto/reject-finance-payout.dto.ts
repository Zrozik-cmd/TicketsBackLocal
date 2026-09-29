import { IsOptional, IsString, MaxLength } from 'class-validator';

/** JSON {reason?} — отклонить запрос организатора. */
export class RejectFinancePayoutDto {
  @IsOptional()
  @IsString({ message: 'finance_invalid_payload' })
  @MaxLength(500, { message: 'finance_note_too_long' })
  reason?: string;
}
