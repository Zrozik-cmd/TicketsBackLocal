import { Transform, Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import type { MockOrderPaymentCurrency, MockOrderStatus, RefundStatus } from '../schemas/mock-order.schema';
import type { IMockOrderTicket } from '../schemas/mock-order.schema';
import { SessionPeriodFilterQueryDto } from '../../events/dto/session-period-filter.dto';

function optionalQueryString(value: unknown): string | undefined {
  if (value === '' || value == null) {
    return undefined;
  }
  return typeof value === 'string' ? value : undefined;
}

/**
 * `from`/`to`/`sessionId` (inherited) keep only orders with at least one ticket line of
 * those shows; without them the list is exactly the historical one.
 */
export class MockOrdersPaidListQueryDto extends SessionPeriodFilterQueryDto {
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
  @Max(1000)
  limit?: number;

  @IsOptional()
  @Transform(({ value }) => optionalQueryString(value))
  @IsString()
  email?: string;

  @IsOptional()
  @Transform(({ value }) => optionalQueryString(value))
  @IsString()
  orderId?: string;

  @IsOptional()
  @Transform(({ value }) => optionalQueryString(value))
  @IsString()
  customerName?: string;
}

export interface MockOrderEventPaidListRow {
  id: number;
  createdAt: string;
  status: MockOrderStatus;
  total_price: number;
  price: number;
  paymentCurrency: MockOrderPaymentCurrency;
  paymentMethod: string;
  /** Amount paid by the customer in `paymentCurrency`. */
  originalPaidAmount: number | null;
  numberOfTheTickets: number;
  customerName: string;
  email: string;
  /** Present on doc when a promo applied; otherwise null. */
  promocodeDiscount: number | null;
  processing_fee: number;
  platform_fee: number;
  /** VAT line (excludes additional ticket cost fee). */
  vat_fee: number;
  additional_ticket_cost_fee: number;
  /** Bank-card surcharge paid by the buyer; 0 for non-card orders. */
  bank_card_fee: number;
  /** Service commission paid by the buyer on cash orders; 0 otherwise. */
  cash_fee: number;
  net_payout: number;
  /** Stored order lines; lines of a regular event carry `session`, `sessionDate`, `sessionStart`, `sessionEnd`. */
  tickets: IMockOrderTicket[];
  refundStatus: RefundStatus;
  refundStatusChangedByEmail?: string;
  refundAmount: number | null;
  refundCurrency: string | null;
  refundCreatedAt: string | null;
  refundCompletedAt: string | null;
  selected_pos?: string | null;
  actual_pos?: string | null;
  cashier_email?: string | null;
  payment_confirmed_at?: string | null;
}

export interface MockOrderEventPaidListResponse {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  rows: MockOrderEventPaidListRow[];
}
