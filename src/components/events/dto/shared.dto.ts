import {
  IsString,
  IsNumber,
  IsInt,
  IsBoolean,
  IsOptional,
  IsDefined,
  IsIn,
  Min,
  Max,
  ValidateNested,
  IsArray,
  ArrayMinSize,
  MaxLength,
  MinLength,
  Length,
  ValidateIf,
  Matches,
  registerDecorator,
  ValidationOptions,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import {
  SALES_CLOSE_BEFORE_UNITS,
  type SalesCloseBeforeUnit,
} from '../schemas/event.schema';
import {
  EVENT_SPONSOR_ID_PATTERN,
  EVENT_SPONSOR_NAME_MAX_LENGTH,
  EVENT_SPONSOR_URL_MAX_LENGTH,
} from '../constants/event-sponsors.constant';
import { isSponsorHttpUrl } from '../utils/event-sponsors.util';

/** Accepts http(s) URL or data URL (e.g. data:image/jpeg;base64,...) */
const URL_OR_DATA_URL = /^(https?:\/\/[^\s]+|data:[^;]+;base64,.+)$/;

/** At least one of th, en, ru must be a non-empty string */
export function IsLocalizedTextNonEmpty(validationOptions?: ValidationOptions) {
  return function (object: Object, propertyName: string) {
    registerDecorator({
      name: 'isLocalizedTextNonEmpty',
      target: object.constructor,
      propertyName,
      options: validationOptions ?? { message: 'At least one language (th, en or ru) must be filled' },
      validator: {
        validate(value: unknown) {
          if (!value || typeof value !== 'object') return false;
          const o = value as Record<string, unknown>;
          const th = o.th;
          const en = o.en;
          const ru = o.ru;
          return (
            (typeof th === 'string' && th.trim() !== '') ||
            (typeof en === 'string' && en.trim() !== '') ||
            (typeof ru === 'string' && ru.trim() !== '')
          );
        },
      },
    });
  };
}

export class LocalizedTextDto {
  @IsOptional()
  @IsString()
  th?: string;

  @IsOptional()
  @IsString()
  en?: string;

  @IsOptional()
  @IsString()
  ru?: string;
}

export class ImageInfoDto {
  @IsString()
  id: string;

  @Matches(URL_OR_DATA_URL, { message: 'url must be an http(s) URL or a base64 data URL' })
  @IsString()
  url: string;

  @IsString()
  fileName: string;

  @IsString()
  mimeType: string;

  @IsNumber()
  @Min(0)
  size: number;

  @IsNumber()
  @Min(1)
  width: number;

  @IsNumber()
  @Min(1)
  height: number;
}

/**
 * One entry of the event's extra gallery: either a freshly picked image (data
 * URL, uploaded on save) or an already stored Media id (kept as is). Lets an
 * edit re-send the whole ordered list without re-uploading untouched photos.
 * Declared after ImageInfoDto: `emitDecoratorMetadata` references the property
 * type at class-definition time, so a forward reference is a TDZ error.
 */
export class GalleryImageDto {
  @IsOptional()
  @IsNumber()
  @Min(1)
  mediaId?: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => ImageInfoDto)
  image?: ImageInfoDto;
}

/**
 * Logo of a sponsor: exactly one of `mediaId` (keep a logo this event's sponsors already use)
 * and `image` (new upload: base64 png/jpeg/webp data URL of at most 2 MB, checked by the
 * service, 400 `sponsor_logo_invalid`). Declared after ImageInfoDto (TDZ, see above).
 */
export class SponsorLogoDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  mediaId?: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => ImageInfoDto)
  image?: ImageInfoDto;
}

/** `logo` must carry exactly one of `mediaId` and `image`. */
export function IsSponsorLogoChoice(validationOptions?: ValidationOptions) {
  return function (object: Object, propertyName: string) {
    registerDecorator({
      name: 'isSponsorLogoChoice',
      target: object.constructor,
      propertyName,
      options: validationOptions ?? { message: '$property must have exactly one of mediaId or image' },
      validator: {
        validate(value: unknown) {
          if (!value || typeof value !== 'object') return false;
          const o = value as Record<string, unknown>;
          return (o.mediaId != null) !== (o.image != null);
        },
      },
    });
  };
}

/** Empty, or an absolute http(s) URL without whitespace: it becomes a link in the PDF ticket. */
export function IsSponsorUrl(validationOptions?: ValidationOptions) {
  return function (object: Object, propertyName: string) {
    registerDecorator({
      name: 'isSponsorUrl',
      target: object.constructor,
      propertyName,
      options: validationOptions ?? { message: '$property must be an http(s) URL' },
      validator: {
        validate(value: unknown) {
          return value === '' || isSponsorHttpUrl(value);
        },
      },
    });
  };
}

const trimSponsorText = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/**
 * One sponsor of the ticket's "Sponsored by" block. `name` and `url` are trimmed; absent or
 * `''` means none. Declared after SponsorLogoDto (TDZ, see GalleryImageDto).
 */
export class EventSponsorDto {
  @IsString()
  @Matches(EVENT_SPONSOR_ID_PATTERN, {
    message: '$property must be 1-64 characters: letters, digits, _ or -',
  })
  id: string;

  @IsDefined()
  @IsSponsorLogoChoice()
  @ValidateNested()
  @Type(() => SponsorLogoDto)
  logo: SponsorLogoDto;

  @IsOptional()
  @Transform(trimSponsorText)
  @IsString()
  @MaxLength(EVENT_SPONSOR_NAME_MAX_LENGTH)
  name?: string;

  @IsOptional()
  @Transform(trimSponsorText)
  @IsString()
  @MaxLength(EVENT_SPONSOR_URL_MAX_LENGTH)
  @IsSponsorUrl()
  url?: string;
}

/** At least one of th, en, ru must have an image with a non-empty url */
export function IsLocalizedImageNonEmpty(validationOptions?: ValidationOptions) {
  return function (object: Object, propertyName: string) {
    registerDecorator({
      name: 'isLocalizedImageNonEmpty',
      target: object.constructor,
      propertyName,
      options:
        validationOptions ?? {
          message: 'At least one language image (th, en or ru) must be provided',
        },
      validator: {
        validate(value: unknown) {
          if (!value || typeof value !== 'object') return false;
          const o = value as Record<string, unknown>;
          for (const key of ['th', 'en', 'ru']) {
            const img = o[key];
            if (
              img &&
              typeof img === 'object' &&
              typeof (img as { url?: unknown }).url === 'string' &&
              (img as { url: string }).url.trim() !== ''
            ) {
              return true;
            }
          }
          return false;
        },
      },
    });
  };
}

export class LocalizedImageDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => ImageInfoDto)
  th?: ImageInfoDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => ImageInfoDto)
  en?: ImageInfoDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => ImageInfoDto)
  ru?: ImageInfoDto;
}

export class EventDateDto {
  @IsBoolean()
  isRange: boolean;

  @IsString()
  startDate: string;

  @ValidateIf((o) => o.isRange === true)
  @IsString()
  endDate?: string;
}

export class TimeDto {
  @IsBoolean()
  allDay: boolean;

  @IsString()
  start: string;

  @IsString()
  end: string;
}

export class IdLabelDto {
  @IsString()
  id: string;

  @IsString()
  @MaxLength(200)
  label: string;
}

export class VenueDto {
  /** Название площадки; необязательное — старые клиенты его не шлют. */
  @IsOptional()
  @IsString()
  name?: string;

  @IsString()
  address: string;

  @IsOptional()
  @IsString()
  placeId?: string;

  @IsOptional()
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat?: number;

  @IsOptional()
  @IsNumber()
  @Min(-180)
  @Max(180)
  lng?: number;
}

export class ZoneDto {
  @IsString()
  id: string;

  @IsLocalizedTextNonEmpty()
  @ValidateNested()
  @Type(() => LocalizedTextDto)
  name: LocalizedTextDto;

  @IsNumber()
  @Min(1, { message: 'Seats must be at least 1' })
  seats: number;

  @IsBoolean()
  isFree: boolean;

  @IsNumber()
  @Min(0)
  price: number;

  @IsString()
  currency: string;
}

export class SectorDto {
  @IsString()
  id: string;

  @IsString()
  color: string;

  @IsLocalizedTextNonEmpty()
  @ValidateNested()
  @Type(() => LocalizedTextDto)
  name: LocalizedTextDto;

  @ArrayMinSize(1, { message: 'Each sector must have at least one zone' })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ZoneDto)
  zones: ZoneDto[];
}

export class ExternalLinkDto {
  @IsString()
  id: string;

  @IsString()
  @IsIn(['instagram', 'tiktok', 'telegram', 'other'])
  platform: string;

  @IsOptional()
  @IsString()
  displayName?: string;

  @IsOptional()
  @IsString()
  url?: string;
}

export class ThbPaymentDetailsDto {
  @IsString()
  @Matches(/^\d{3}-\d-\d{5}-\d$/, {
    message: 'accountNumber must match 888-8-88888-1 format',
  })
  accountNumber: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  recipientName: string;

  @IsString()
  @MinLength(10)
  @MaxLength(25)
  @Matches(/^[+]?[0-9\s()-]+$/, {
    message: 'phoneNumber must contain only digits and optional + - ( )',
  })
  phoneNumber: string;

  @IsOptional()
  @IsString()
  @Length(6, 6, { message: 'phoneCode must be exactly 6 characters' })
  phoneCode?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => ImageInfoDto)
  qrCodeImage?: ImageInfoDto;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export class RecurrenceSessionDto {
  @IsDefined()
  @IsString()
  @Matches(CLOCK_TIME, { message: 'start must be HH:mm' })
  start: string;

  @IsDefined()
  @IsString()
  @Matches(CLOCK_TIME, { message: 'end must be HH:mm' })
  end: string;
}

/** Repeating schedule of a regular event. Omitted entirely for one-off events. */
export class RecurrenceDto {
  @IsDefined()
  @IsBoolean()
  enabled: boolean;

  @IsDefined()
  @IsString()
  @Matches(ISO_DATE, { message: 'periodStart must be YYYY-MM-DD' })
  periodStart: string;

  @IsDefined()
  @IsString()
  @Matches(ISO_DATE, { message: 'periodEnd must be YYYY-MM-DD' })
  periodEnd: string;

  @IsDefined()
  @IsArray()
  @ArrayMinSize(1)
  @IsNumber({}, { each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  weekdays: number[];

  @IsDefined()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => RecurrenceSessionDto)
  sessions: RecurrenceSessionDto[];

  @IsOptional()
  @IsIn([15, 30, 60])
  stepMinutes?: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Matches(ISO_DATE, { each: true, message: 'exceptions must be YYYY-MM-DD' })
  exceptions?: string[];
}

/** Automatic stop of ticket sales `value` hours/days before the start (one-off and regular events). */
export class SalesCloseBeforeDto {
  @IsDefined()
  @IsBoolean()
  enabled: boolean;

  @IsDefined()
  @IsInt()
  @Min(1)
  @Max(720)
  value: number;

  @IsDefined()
  @IsIn([...SALES_CLOSE_BEFORE_UNITS])
  unit: SalesCloseBeforeUnit;
}

export class EventPaymentOptionsDto {
  /**
   * Legacy manual THB receiver details. PromptPay is issued by Omise now, so
   * organizers no longer submit them; kept optional for older clients and so
   * existing events keep whatever they already stored.
   */
  @IsOptional()
  @ValidateNested()
  @Type(() => ThbPaymentDetailsDto)
  thb?: ThbPaymentDetailsDto;

  @IsOptional()
  @IsBoolean()
  cashEnabled?: boolean;
}
