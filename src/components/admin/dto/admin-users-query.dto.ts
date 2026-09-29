import { Transform, Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from "class-validator";

const STATUS = ["all", "active", "inactive"] as const;
/*
 * Фильтр проверки отдельный от STATUS: тот про наличие активных событий,
 * этот — про состояние заявки организатора. Смешивать их нельзя.
 */
const VERIFICATION = ["all", "pending", "approved", "rejected"] as const;
const SORT_BY = [
  "createdAt",
  "email",
  "companyVenueName",
  "displayName",
  "responsiblePersonFullName",
  "provinceRegion",
  "country",
  "eventsCount",
] as const;
const ORDER = ["asc", "desc"] as const;

function optionalQueryString(value: unknown): string | undefined {
  if (value === "" || value == null) {
    return undefined;
  }
  return typeof value === "string" ? value : undefined;
}

export class AdminUsersQueryDto {
  @IsOptional()
  @Transform(({ value }) => optionalQueryString(value))
  @IsString()
  search?: string;

  @IsOptional()
  @IsIn(STATUS)
  status?: (typeof STATUS)[number];

  @IsOptional()
  @IsIn(VERIFICATION)
  verification?: (typeof VERIFICATION)[number];

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
