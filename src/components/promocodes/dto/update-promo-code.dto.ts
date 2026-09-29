import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { DISCOUNT_TYPES, DiscountType } from '../schemas/promo-code.schema';

export class UpdatePromoCodeDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  internalName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  assignedTo?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  promoCode?: string;

  @IsOptional()
  @IsIn(DISCOUNT_TYPES)
  discountType?: DiscountType;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  discountValue?: number;

  @IsOptional()
  @IsISO8601()
  expirationDate?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  maxTicketsCountByCustomer?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  maxTicketsCountTotal?: number;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  applyToAllEvents?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  applicableEventIds?: string[];
}
