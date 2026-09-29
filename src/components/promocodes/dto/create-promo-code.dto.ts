import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { DISCOUNT_TYPES, DiscountType } from '../schemas/promo-code.schema';

export class CreatePromoCodeDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  internalName: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  assignedTo?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  promoCode: string;

  @IsIn(DISCOUNT_TYPES)
  discountType: DiscountType;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @ValidateIf((o) => o.discountType === 'percentage')
  @Max(100)
  discountValue: number;

  @IsISO8601()
  expirationDate: string;

  @Type(() => Number)
  @IsNumber()
  @Min(1)
  maxTicketsCountByCustomer: number;

  @Type(() => Number)
  @IsNumber()
  @Min(1)
  maxTicketsCountTotal: number;

  @Type(() => Boolean)
  @IsBoolean()
  applyToAllEvents: boolean;

  @ValidateIf((o) => !o.applyToAllEvents)
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  applicableEventIds?: string[];
}
