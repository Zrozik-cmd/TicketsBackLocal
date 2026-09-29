import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsOptional, ValidateNested } from 'class-validator';
import { EventSponsorDto } from '../../events/dto/shared.dto';
import { EVENT_MAX_SPONSORS } from '../../events/constants/event-sponsors.constant';
import {
  EVENT_TICKET_FORMATS,
  type EventTicketFormat,
} from '../../events/schemas/event.schema';

/**
 * The event's sponsors as an admin saves them (`PUT /admin/events/:id/sponsors`). The whole
 * list is authoritative — `[]` removes the "Sponsored by" block. `EventSponsorDto` is the very
 * same nested DTO the organizer form used before the block moved to the admin panel, so the
 * per-row rules (id pattern, logo choice, 15-character name, http(s) link) stay identical.
 */
export class UpdateEventSponsorsDto {
  @IsArray()
  @ArrayMaxSize(EVENT_MAX_SPONSORS)
  @ValidateNested({ each: true })
  @Type(() => EventSponsorDto)
  sponsors: EventSponsorDto[];

  /**
   * Format of the tickets attached to e-mails (absent = keep the stored one, `'webp'` by
   * default); any sponsor link requires `'pdf'` (400 `ticket_format_pdf_required`).
   */
  @IsOptional()
  @IsIn([...EVENT_TICKET_FORMATS])
  ticketFormat?: EventTicketFormat;
}
