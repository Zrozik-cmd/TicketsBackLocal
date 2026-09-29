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
import { MOCK_ORDER_PAYMENT_METHODS } from "../../mock-orders/schemas/mock-order.schema";

export const ADMIN_VAULT_TICKET_SEARCH_FIELDS = [
  "auto",
  "email",
  "code",
  "ticketId",
  "orderId",
  "bookingCode",
  "name",
  "phone",
  "event",
] as const;
export const ADMIN_VAULT_TICKET_STATUSES = ["ACTIVE", "USED"] as const;

function optionalQueryString(value: unknown): string | undefined {
  if (value === "" || value == null) {
    return undefined;
  }
  return typeof value === "string" ? value : undefined;
}

/** `GET /admin/vault/tickets` — поиск билетов по всем событиям. */
export class AdminVaultTicketSearchQueryDto {
  @IsOptional()
  @Transform(({ value }) => optionalQueryString(value)?.trim() || undefined)
  @IsString()
  @MaxLength(200)
  q?: string;

  @IsOptional()
  @Transform(({ value }) => optionalQueryString(value))
  @IsIn(ADMIN_VAULT_TICKET_SEARCH_FIELDS)
  field?: (typeof ADMIN_VAULT_TICKET_SEARCH_FIELDS)[number];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  eventId?: number;

  @IsOptional()
  @Transform(({ value }) => optionalQueryString(value))
  @IsIn(ADMIN_VAULT_TICKET_STATUSES)
  status?: (typeof ADMIN_VAULT_TICKET_STATUSES)[number];

  @IsOptional()
  @Transform(({ value }) => optionalQueryString(value))
  @IsIn([...MOCK_ORDER_PAYMENT_METHODS])
  paymentMethod?: string;

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
