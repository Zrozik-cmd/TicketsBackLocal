import { IsBoolean, IsIn, IsOptional } from 'class-validator';
import {
  REVIEW_AUDIENCES,
  type ReviewAudience,
} from '../../events/schemas/event.schema';

/** Admin-only: turn reviews on/off for an event and choose who may leave one. */
export class UpdateReviewSettingsDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsIn([...REVIEW_AUDIENCES])
  audience?: ReviewAudience;

  /** Allow reviews before the show has been performed. */
  @IsOptional()
  @IsBoolean()
  allowBeforeEvent?: boolean;
}
