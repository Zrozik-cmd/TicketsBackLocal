import { Transform, Type } from "class-transformer";
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from "class-validator";
import { EVENT_STATUSES } from "../../events/constants/event-status.constant";

const SORT_BY = ["createdAt", "eventDate"] as const;
const ORDER = ["asc", "desc"] as const;

function optionalQueryString(value: unknown): string | undefined {
  if (value === "" || value == null) {
    return undefined;
  }
  return typeof value === "string" ? value : undefined;
}

export class AdminEventsQueryDto {
  @IsOptional()
  @Transform(({ value }) => optionalQueryString(value))
  @IsIn([...EVENT_STATUSES])
  status?: string;

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

  /**
   * `true`: only events with sponsor changes awaiting approval (not archived by the organizer;
   * ACTIVE, PAUSED, COMPLETED, CANCELLED or MODERATION).
   */
  @IsOptional()
  @Transform(({ value }) =>
    value === "" || value == null ? undefined : value === "true" ? true : value === "false" ? false : value,
  )
  @IsBoolean()
  pendingChanges?: boolean;
}
