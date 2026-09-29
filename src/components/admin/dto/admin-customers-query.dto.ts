import { Transform, Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from "class-validator";

const FILTER = ["all", "active", "inactive", "referral"] as const;
const SORT_BY = [
  "createdAt",
  "email",
  "fullname",
  "ordersCount",
  "ticketsCount",
  "totalSpent",
] as const;
const ORDER = ["asc", "desc"] as const;

function optionalQueryString(value: unknown): string | undefined {
  if (value === "" || value == null) {
    return undefined;
  }
  return typeof value === "string" ? value : undefined;
}

export class AdminCustomersQueryDto {
  @IsOptional()
  @Transform(({ value }) => optionalQueryString(value))
  @IsString()
  search?: string;

  @IsOptional()
  @IsIn(FILTER)
  filter?: (typeof FILTER)[number];

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
