import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

/** JSON {ledgerEntryIds: number[] (1..200), note?} — инкассации дошли до сейфа. */
export class ConfirmVaultReceiptsDto {
  @IsArray({ message: 'finance_invalid_payload' })
  @ArrayMinSize(1, { message: 'finance_invalid_payload' })
  @ArrayMaxSize(200, { message: 'finance_invalid_payload' })
  @IsInt({ each: true, message: 'finance_invalid_payload' })
  @Min(1, { each: true, message: 'finance_invalid_payload' })
  ledgerEntryIds: number[];

  @IsOptional()
  @IsString({ message: 'finance_invalid_payload' })
  @MaxLength(500, { message: 'finance_note_too_long' })
  note?: string;
}
