import { Type } from 'class-transformer';
import {
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  NotEquals,
} from 'class-validator';

/** Корректировка кассы: только админ, всегда с примечанием-причиной. */
export class CreateAdjustmentDto {
  /** Чью кассу корректируем; без поля — общая касса админки. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  cashier_id?: number;

  /** Подписанная сумма: плюс — доложили, минус — изъяли. */
  @IsNumber({ maxDecimalPlaces: 2 })
  @NotEquals(0)
  amount: number;

  @IsString()
  @MinLength(3)
  @MaxLength(300)
  note: string;
}
