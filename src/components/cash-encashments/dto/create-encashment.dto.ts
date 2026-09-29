import { IsNumber, IsPositive, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateEncashmentDto {
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount: number;

  /** Имя из справочника инкассаторов или введённое вручную. */
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  collector_name: string;
}
