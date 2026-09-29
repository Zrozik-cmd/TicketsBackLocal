import { IsEmail, IsIn, IsInt, IsOptional, Min } from 'class-validator';

export class ManualResendOrderTicketsDto {
  @IsInt()
  @Min(1)
  orderId: number;

  @IsEmail()
  email: string;

  @IsOptional()
  @IsIn(['en', 'ru', 'th'], {
    message: 'locale must be en, ru or th',
  })
  locale?: 'en' | 'ru' | 'th';
}
