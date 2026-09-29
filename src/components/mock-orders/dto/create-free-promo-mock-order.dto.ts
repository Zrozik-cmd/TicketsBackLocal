import {
  IsBoolean,
  IsNumber,
  IsArray,
  ValidateNested,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { MockOrderTicketDto } from './mock-order-ticket.dto';

/**
 * Same as checkout body for POST /mock-orders, but promo is required and no payment currency
 * (used for 100%-off promos: order is confirmed without a payment microservice transaction).
 */
export class CreateFreePromoMockOrderDto {
  @IsNumber()
  event: number;

  @IsOptional()
  @IsNumber()
  customer?: number;

  @IsOptional()
  @IsIn(['en', 'ru', 'th'], {
    message: 'locale must be en, ru or th',
  })
  locale?: 'en' | 'ru' | 'th';

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  promoCode: string;

  /** Optional email-marketing consent checkbox; forwarded to Mailchimp on confirmation. */
  @IsOptional()
  @IsBoolean()
  newsletterOptIn?: boolean;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MockOrderTicketDto)
  tickets: MockOrderTicketDto[];
}
