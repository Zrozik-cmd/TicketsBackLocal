import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

const SORT_BY = ['sortOrder', 'createdAt'] as const;
const ORDER = ['asc', 'desc'] as const;

function optionalQueryString(value: unknown): string | undefined {
  if (value === '' || value == null) {
    return undefined;
  }
  return typeof value === 'string' ? value : undefined;
}

function optionalQueryBoolean(value: unknown): boolean | undefined {
  if (value === '' || value == null) {
    return undefined;
  }
  if (value === true || value === 'true') {
    return true;
  }
  if (value === false || value === 'false') {
    return false;
  }
  return undefined;
}

export class AdminBannersQueryDto {
  @IsOptional()
  @Transform(({ value }) => optionalQueryBoolean(value))
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @Transform(({ value }) => optionalQueryString(value))
  @IsString()
  search?: string;

  @IsOptional()
  @IsIn(SORT_BY)
  sortBy?: (typeof SORT_BY)[number];

  @IsOptional()
  @IsIn(ORDER)
  order?: (typeof ORDER)[number];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;
}
