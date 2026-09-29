import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional } from 'class-validator';
import {
  DELIVERY_RETRY_LIMIT_OPTIONS,
  type DeliveryRetryLimit,
} from '../constants/event-messengers.constants';

/**
 * `POST admin/events/:id/messengers/line/deliveries/retry` — re-sends this event's failed
 * LINE messages, newest first. `limit` absent = every failed one (still capped server-side
 * by `DELIVERY_MANUAL_RETRY_MAX`).
 */
export class RetryLineDeliveriesDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn(DELIVERY_RETRY_LIMIT_OPTIONS as unknown as number[], {
    message: `limit must be one of ${DELIVERY_RETRY_LIMIT_OPTIONS.join(', ')}`,
  })
  limit?: DeliveryRetryLimit;
}
