import {
  ArrayMaxSize,
  IsEmail,
  IsString,
  IsIn,
  IsArray,
  ValidateIf,
  ValidateNested,
  IsOptional,
  IsDefined,
  IsNumber,
  MaxLength,
  Min,
} from 'class-validator';
import { EVENT_CITIES, EventCity } from '../schemas/event.schema';

/** Extra gallery photos per event, on top of the cover. */
export const EVENT_MAX_GALLERY = 8;
import { Transform, Type } from 'class-transformer';
import {
  LocalizedTextDto,
  ImageInfoDto,
  GalleryImageDto,
  EventDateDto,
  TimeDto,
  IdLabelDto,
  VenueDto,
  SectorDto,
  ExternalLinkDto,
  EventPaymentOptionsDto,
  RecurrenceDto,
  SalesCloseBeforeDto,
} from './shared.dto';
import {
  CREATE_EVENT_INITIAL_STATUSES,
  type CreateEventInitialStatus,
} from '../constants/event-status.constant';

export class CreateEventDto {
  /** creator is set from JWT in controller, never from body */

  @IsDefined()
  @IsIn([...CREATE_EVENT_INITIAL_STATUSES])
  status: CreateEventInitialStatus;

  @IsDefined()
  @ValidateNested()
  @Type(() => LocalizedTextDto)
  title: LocalizedTextDto;

  @IsDefined()
  @ValidateNested()
  @Type(() => ImageInfoDto)
  coverImage: ImageInfoDto;

  /**
   * Extra hero photos after the cover, in display order (max EVENT_MAX_GALLERY).
   * On update the full list is authoritative: media ids absent from it are deleted.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(EVENT_MAX_GALLERY)
  @ValidateNested({ each: true })
  @Type(() => GalleryImageDto)
  galleryImages?: GalleryImageDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => ImageInfoDto)
  seatingPlanImage?: ImageInfoDto;

  @IsOptional()
  @IsNumber()
  @Min(1)
  seatingPlanSeats?: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => ImageInfoDto)
  parkingPlanImage?: ImageInfoDto;

  @IsOptional()
  @IsNumber()
  @Min(1)
  parkingPlanSeats?: number;

  @IsDefined()
  @ValidateNested()
  @Type(() => LocalizedTextDto)
  description: LocalizedTextDto;

  @IsDefined()
  @ValidateNested()
  @Type(() => EventDateDto)
  eventDate: EventDateDto;

  @IsDefined()
  @ValidateNested()
  @Type(() => TimeDto)
  time: TimeDto;

  @IsDefined()
  @ValidateNested()
  @Type(() => IdLabelDto)
  category: IdLabelDto;

  @IsDefined()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => IdLabelDto)
  tags: IdLabelDto[];

  @IsDefined()
  @ValidateNested()
  @Type(() => IdLabelDto)
  province: IdLabelDto;

  /** Гео-раздел афиши. Обязателен: каждое событие попадает ровно в один город. */
  @IsDefined()
  @IsIn([...EVENT_CITIES])
  city: EventCity;

  @IsDefined()
  @ValidateNested()
  @Type(() => VenueDto)
  venue: VenueDto;

  @IsDefined()
  @IsString()
  @IsIn(['th', 'en', 'ru'])
  eventLanguage: string;

  @IsDefined()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SectorDto)
  sectors: SectorDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ExternalLinkDto)
  externalLinks?: ExternalLinkDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => LocalizedTextDto)
  refundPolicy?: LocalizedTextDto;

  @IsDefined()
  @ValidateNested()
  @Type(() => EventPaymentOptionsDto)
  paymentOptions: EventPaymentOptionsDto;

  /**
   * Repeating schedule. Sent only for regular events; one-off events omit it and
   * keep using `eventDate` + `time` exactly as before.
   */
  @IsOptional()
  @ValidateNested()
  @Type(() => RecurrenceDto)
  recurrence?: RecurrenceDto;

  /**
   * Stop ticket sales X hours/days before the start (the event's for a one-off, each
   * session's for a regular event). Omitted = sell until the start, as before.
   * Editing it never sends a published event back to moderation.
   */
  @IsOptional()
  @ValidateNested()
  @Type(() => SalesCloseBeforeDto)
  salesCloseBefore?: SalesCloseBeforeDto;

  /**
   * Mailbox that gets an English copy of every ticket e-mail of this event. Trimmed and
   * lowercased; `''` clears it (validated as an e-mail only when non-empty). Editing it
   * never sends a published event back to moderation.
   */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @ValidateIf((_, value) => value !== '' && value != null)
  @IsString()
  @MaxLength(254)
  @IsEmail()
  ticketCopyEmail?: string;

  /** Venue working hours, e.g. "Open today: 10.30-19.00, Last entry at 18:00". */
  @IsOptional()
  @IsString()
  @MaxLength(160)
  venueSchedule?: string;
}
