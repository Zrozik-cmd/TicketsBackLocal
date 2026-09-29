import { ConflictException, NotFoundException } from '@nestjs/common';
import mongoose from 'mongoose';
import type { IEvent } from '../../events/schemas/event.schema';
import { ADMIN_EVENT_ERROR } from '../constants/admin-event.constant';

/**
 * Read, decide, write: the write only matches the event as read (`updatedAt` + `guard`), so
 * nothing that landed in between is overwritten. Re-read and retried then; 409
 * `event_changed_concurrently` after 3 attempts. `build` throws the action's own errors.
 *
 * Shared by every admin write to an Event (confirm, sponsors approve, sponsors save): a second
 * copy of this loop would silently drop the guard of whichever copy was not updated.
 */
export async function updateEventGuarded(
  model: mongoose.Model<IEvent>,
  id: number,
  guard: Record<string, unknown>,
  build: (current: IEvent) => mongoose.UpdateQuery<IEvent>,
): Promise<{ before: IEvent; after: IEvent }> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = (await model.findOne({ id }).lean().exec()) as IEvent | null;
    if (!before) {
      throw new NotFoundException('Event not found');
    }
    const update = build(before);
    const filter = {
      ...guard,
      id,
      updatedAt: before.updatedAt ?? { $exists: false },
    } as mongoose.FilterQuery<IEvent>;
    const after = (await model
      .findOneAndUpdate(filter, update, { new: true })
      .lean()
      .exec()) as IEvent | null;
    if (after) {
      return { before, after };
    }
  }
  throw new ConflictException(ADMIN_EVENT_ERROR.CHANGED_CONCURRENTLY);
}

/** `$set` / `$unset` of an admin write, with the empty halves left out. */
export function toUpdateQuery(
  set: Record<string, unknown>,
  unset: Record<string, 1>,
): mongoose.UpdateQuery<IEvent> {
  const update: mongoose.UpdateQuery<IEvent> = {};
  if (Object.keys(set).length) {
    update.$set = set;
  }
  if (Object.keys(unset).length) {
    update.$unset = unset;
  }
  return update;
}
