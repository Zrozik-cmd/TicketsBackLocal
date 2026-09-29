import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { SessionPeriodFilterQueryDto } from '../../events/dto/session-period-filter.dto';

export const TICKET_REGISTRY_STATUS_FILTERS = [
  'all',
  'active',
  'used',
  'refunded',
  'cancelled',
] as const;
export type TicketRegistryStatusFilter = (typeof TICKET_REGISTRY_STATUS_FILTERS)[number];

/**
 * - `active`    — issued, not scanned yet, its show still on.
 * - `used`      — scanned at the entrance.
 * - `refunded`  — the order was refunded; the ticket itself no longer exists.
 * - `cancelled` — issued and not scanned, but its session was cancelled.
 */
export type TicketRegistryStatus = Exclude<TicketRegistryStatusFilter, 'all'>;

export const TICKET_REGISTRY_LOCALES = ['en', 'ru', 'th'] as const;
export type TicketRegistryLocale = (typeof TICKET_REGISTRY_LOCALES)[number];

/** A trimmed query-string value; blank or non-string input counts as absent. */
export function optionalQueryString(value: unknown): string | undefined {
  if (value === '' || value == null) {
    return undefined;
  }
  return typeof value === 'string' ? value.trim() || undefined : undefined;
}

/**
 * GET /events/private/:id/tickets-registry. `from`/`to`/`sessionId` (inherited) filter
 * by the show a ticket is for, never by the purchase date.
 */
export class TicketRegistryQueryDto extends SessionPeriodFilterQueryDto {
  /** Ticket code or barcode, ticket id, order number, buyer e-mail / name / phone. */
  @IsOptional()
  @Transform(({ value }) => optionalQueryString(value))
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @Transform(({ value }) => optionalQueryString(value))
  @IsIn([...TICKET_REGISTRY_STATUS_FILTERS])
  status?: TicketRegistryStatusFilter;

  /** Bounded so `(page - 1) × limit` stays a valid Mongo `$skip` (an absurd page is a 400, not a 500). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100000)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  /** Language of sector and zone names. */
  @IsOptional()
  @Transform(({ value }) => optionalQueryString(value))
  @IsIn([...TICKET_REGISTRY_LOCALES])
  locale?: TicketRegistryLocale;
}

/** GET /events/private/:id/tickets/:ticketId/pdf */
export class TicketPdfQueryDto {
  @IsOptional()
  @Transform(({ value }) => optionalQueryString(value))
  @IsIn([...TICKET_REGISTRY_LOCALES])
  locale?: TicketRegistryLocale;
}

export interface TicketRegistryItem {
  ticketId: number;
  code: string;
  orderId: number;
  status: TicketRegistryStatus;
  buyer: { name: string | null; email: string | null; phone: string | null };
  sectorName: string;
  zoneName: string;
  price: number;
  currency: string;
  /** `null` for a one-off event, whose date/time fields fall back to the event's own. */
  sessionId: number | null;
  sessionDate: string | null;
  sessionStart: string | null;
  sessionEnd: string | null;
  /** ISO. */
  purchasedAt: string | null;
  /** ISO of the successful scan, when there is one. */
  usedAt: string | null;
  /** `false` for refunded tickets — there is no ticket left to print. */
  pdfAvailable: boolean;
}

export interface TicketRegistryResponse {
  items: TicketRegistryItem[];
  total: number;
  page: number;
  limit: number;
}
