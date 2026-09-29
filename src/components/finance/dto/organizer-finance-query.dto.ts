import { Transform } from 'class-transformer';
import { IsInt, IsOptional, Min } from 'class-validator';

/** Пустое значение (`?sessionId=`) = не передано; иначе число из строки запроса. */
const optionalQueryNumber = ({ value }: { value: unknown }) =>
  value === undefined || value === null || value === '' ? undefined : Number(value);

/** `?sessionId=` — один показ регулярного события; без параметра — всё событие. */
export class OrganizerFinanceQueryDto {
  @IsOptional()
  @Transform(optionalQueryNumber)
  @IsInt({ message: 'finance_invalid_payload' })
  @Min(1, { message: 'finance_invalid_payload' })
  sessionId?: number;
}
