import {
  ArrayMaxSize,
  IsArray,
  IsDefined,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { REVIEW_MAX_PHOTOS } from '../schemas/review.schema';

/**
 * Photos arrive as base64 data URLs, the same way event covers do (the media
 * service turns them into `/media/:id` rows). ~4 MB of base64 ≈ a 3 MB JPEG,
 * which the customer form also enforces client-side.
 */
const DATA_URL_IMAGE = /^data:image\/(jpeg|jpg|png|webp|heic|heif);base64,[A-Za-z0-9+/=]+$/i;
const MAX_PHOTO_DATA_URL_LENGTH = 4 * 1024 * 1024;

export class CreateReviewDto {
  @IsDefined()
  @IsInt()
  @Min(1)
  eventId: number;

  @IsDefined()
  @IsInt()
  @Min(1)
  @Max(5)
  rating: number;

  @IsDefined()
  @IsString()
  /** Long enough to actually say something — mirrored in the UI. */
  @MinLength(20)
  @MaxLength(2000)
  message: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(REVIEW_MAX_PHOTOS)
  @IsString({ each: true })
  @MaxLength(MAX_PHOTO_DATA_URL_LENGTH, { each: true })
  @Matches(DATA_URL_IMAGE, { each: true, message: 'each photo must be an image data URL' })
  photos?: string[];
}

export class RejectReviewDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

/** Admin-only correction of an existing review. */
export class UpdateReviewDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  rating?: number;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  message?: string;
}
