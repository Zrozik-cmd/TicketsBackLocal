import { IsIn, IsOptional } from 'class-validator';

export class ResendOrderTicketsDto {
  @IsOptional()
  @IsIn(['en', 'ru', 'th'], {
    message: 'locale must be en, ru or th',
  })
  locale?: 'en' | 'ru' | 'th';
}
