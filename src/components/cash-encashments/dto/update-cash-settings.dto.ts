import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsEmail, IsString, MaxLength } from 'class-validator';

/** Предел списка получателей: это рассылка ответственным, а не маркетинг. */
export const TILL_ALERT_EMAILS_MAX = 20;

export class UpdateCashSettingsDto {
  /*
   * Нормализуем до проверок: пробелы и регистр не должны давать «разные»
   * адреса, а повтор одного адреса — лишнее письмо тому же человеку.
   * Нестроковые элементы оставляем как есть — их отсечёт @IsString.
   */
  @Transform(({ value }) =>
    Array.isArray(value)
      ? Array.from(
          new Set(
            value.map((item: unknown) =>
              typeof item === 'string' ? item.trim().toLowerCase() : item,
            ),
          ),
        )
      : value,
  )
  @IsArray()
  @ArrayMaxSize(TILL_ALERT_EMAILS_MAX)
  @IsString({ each: true })
  @MaxLength(254, { each: true })
  @IsEmail({}, { each: true })
  tillAlertEmails: string[];
}
