import { IsEmail, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class SubscribeNewsletterDto {
  @IsEmail()
  @MaxLength(254)
  email: string;

  @IsOptional()
  @IsIn(['en', 'ru', 'th'], {
    message: 'locale must be en, ru or th',
  })
  locale?: 'en' | 'ru' | 'th';

  /** Honeypot: hidden field a human never fills. A non-empty value marks a bot. */
  @IsOptional()
  @IsString()
  @MaxLength(256)
  website?: string;
}
