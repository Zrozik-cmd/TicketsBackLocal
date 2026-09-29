import { OmitType, PartialType } from '@nestjs/mapped-types';
import { IsIn, IsOptional } from 'class-validator';
import { CreateEventDto } from './create-event.dto';
import { CREATE_EVENT_INITIAL_STATUSES } from '../constants/event-status.constant';

/**
 * Partial update. `status` (DRAFT or MODERATION) may be sent only while the event is
 * DRAFT, MODERATION, or REJECTED (service rejects it for ACTIVE and other statuses).
 */
export class UpdateEventDto extends PartialType(
  OmitType(CreateEventDto, ['status'] as const),
) {
  @IsOptional()
  @IsIn([...CREATE_EVENT_INITIAL_STATUSES])
  status?: (typeof CREATE_EVENT_INITIAL_STATUSES)[number];
}
