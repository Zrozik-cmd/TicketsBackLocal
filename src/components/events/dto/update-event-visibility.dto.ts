import { IsBoolean, IsDefined } from 'class-validator';

/** `PATCH /events/:id/visibility`: `true` hides the event from the site, `false` returns it. */
export class UpdateEventVisibilityDto {
  @IsDefined()
  @IsBoolean()
  hidden: boolean;
}
