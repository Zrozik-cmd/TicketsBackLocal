import { Transform, Type } from "class-transformer";
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import { EVENT_STATUSES } from "../../events/constants/event-status.constant";

export const ADMIN_VAULT_EVENTS_SORT_BY = [
  "createdAt",
  "updatedAt",
  "eventDate",
  "sold",
  "revenue",
] as const;
const ORDER = ["asc", "desc"] as const;
const BOOLEAN_FLAG = ["true", "false"] as const;

function optionalQueryString(value: unknown): string | undefined {
  if (value === "" || value == null) {
    return undefined;
  }
  return typeof value === "string" ? value : undefined;
}

/** `GET /admin/vault/events` — обзор событий для очистки. */
export class AdminVaultEventsQueryDto {
  /** Название (th/en/ru) или точный числовой id. */
  @IsOptional()
  @Transform(({ value }) => optionalQueryString(value)?.trim() || undefined)
  @IsString()
  @MaxLength(200)
  search?: string;

  @IsOptional()
  @Transform(({ value }) => optionalQueryString(value))
  @IsIn([...EVENT_STATUSES])
  status?: string;

  @IsOptional()
  @Transform(({ value }) => optionalQueryString(value))
  @IsIn(BOOLEAN_FLAG)
  deletable?: (typeof BOOLEAN_FLAG)[number];

  @IsOptional()
  @Transform(({ value }) => optionalQueryString(value))
  @IsIn(ADMIN_VAULT_EVENTS_SORT_BY)
  sortBy?: (typeof ADMIN_VAULT_EVENTS_SORT_BY)[number];

  @IsOptional()
  @Transform(({ value }) => optionalQueryString(value))
  @IsIn(ORDER)
  order?: (typeof ORDER)[number];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
