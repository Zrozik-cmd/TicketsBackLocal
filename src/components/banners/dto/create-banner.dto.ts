import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDefined,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  IsLocalizedImageNonEmpty,
  LocalizedImageDto,
  LocalizedTextDto,
} from '../../events/dto/shared.dto';

export class CreateBannerDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => LocalizedTextDto)
  tag?: LocalizedTextDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => LocalizedTextDto)
  title?: LocalizedTextDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => LocalizedTextDto)
  description?: LocalizedTextDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => LocalizedTextDto)
  buttonText?: LocalizedTextDto;

  @IsDefined()
  @ValidateNested()
  @Type(() => LocalizedImageDto)
  @IsLocalizedImageNonEmpty()
  bgImage: LocalizedImageDto;

  @IsString()
  @MaxLength(2048)
  @IsUrl({ require_protocol: true })
  href: string;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  scheduleEnabled?: boolean;

  @IsOptional()
  @IsISO8601()
  startsAt?: string;

  @IsOptional()
  @IsISO8601()
  endsAt?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  sortOrder?: number;
}
