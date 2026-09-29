import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsDefined,
  IsIn,
  IsInt,
  Min,
} from 'class-validator';
import {
  ORGANIZER_SESSION_STATUSES,
  type OrganizerSessionStatus,
} from '../../event-sessions/schemas/event-session.schema';

/** Hard ceiling for one bulk request — a season of daily shows, not the whole collection. */
export const BULK_SESSION_STATUS_MAX_IDS = 500;

/**
 * Organizer action on a single session: sell it out (quota zeroed), reopen it, or
 * cancel it (force majeure, irreversible). `disabled` is system-only and not accepted.
 */
export class UpdateSessionStatusDto {
  @IsDefined()
  @IsIn([...ORGANIZER_SESSION_STATUSES])
  status: OrganizerSessionStatus;
}

/** Same action on many sessions at once; validated all-or-nothing by the service. */
export class BulkUpdateSessionStatusDto {
  @IsDefined()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(BULK_SESSION_STATUS_MAX_IDS)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  sessionIds: number[];

  @IsDefined()
  @IsIn([...ORGANIZER_SESSION_STATUSES])
  status: OrganizerSessionStatus;
}
