import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { ReferralLinkStatus } from '../schemas/referral-link.schema';

export class CreateReferralLinkDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  internalName: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  source: string;

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  referralCode: string;

  @IsString()
  @Matches(/^\d{4}$/)
  partnerCabinetPin: string;

  @IsOptional()
  @IsEnum(['active', 'inactive'] as const)
  status?: ReferralLinkStatus;

  @Type(() => Boolean)
  @IsBoolean()
  hasReward: boolean;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  rewardPercent: number;
}
