import { IsNumber, IsOptional, IsString, MaxLength } from 'class-validator';

/** JSON {amount, note?} — запрос выплаты организатором (THB, ≤ доступного). */
export class CreatePayoutRequestDto {
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 }, { message: 'finance_amount_invalid' })
  amount: number;

  @IsOptional()
  @IsString({ message: 'finance_invalid_payload' })
  @MaxLength(500, { message: 'finance_note_too_long' })
  note?: string;
}
