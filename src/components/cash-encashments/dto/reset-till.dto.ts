import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';

/**
 * Обнуление кассы админом. Причина обязательна: запись остаётся в журнале
 * навсегда и должна объяснять, куда делись деньги.
 */
export class ResetTillDto {
  /** Чью кассу обнуляем; без поля — общая касса админки. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  cashier_id?: number;

  @IsString()
  @MinLength(3)
  @MaxLength(300)
  note: string;
}
