import { IsDefined, IsIn } from 'class-validator';

/**
 * `POST /events/:id/remove`: the outcome the confirmation dialog showed. When the server
 * computes a different one now (a sale landed meanwhile), nothing happens: 409
 * `event_removal_outcome_changed`.
 */
export class RemoveEventDto {
  @IsDefined()
  @IsIn(['delete', 'archive'])
  expect: 'delete' | 'archive';
}
