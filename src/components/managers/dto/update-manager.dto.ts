import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsEmail, IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { MANAGER_TYPES, ManagerType } from '../manager-type';

export class UpdateManagerDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  title: string;

  @IsIn(MANAGER_TYPES)
  type: ManagerType;

  @IsOptional()
  @IsBoolean()
  allEvents?: boolean;

  @IsOptional()
  @IsArray()
  @Type(() => Number)
  @IsInt({ each: true })
  events?: number[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  event?: number;

  @ValidateIf((dto: UpdateManagerDto) => dto.type !== 'Cashier')
  @IsEmail()
  email: string;

  @ValidateIf((dto: UpdateManagerDto) => dto.type === 'Cashier')
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  cashierName?: string;

  @ValidateIf((dto: UpdateManagerDto) => dto.type === 'Cashier')
  @IsString()
  @Matches(/^\d{6}$/, { message: 'cashierPin must be a 6-digit numeric code' })
  cashierPin?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;
}
