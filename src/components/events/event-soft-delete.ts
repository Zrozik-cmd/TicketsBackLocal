import type { Logger } from '@nestjs/common';
import mongoose from 'mongoose';
import { EventSchema, IEvent } from './schemas/event.schema';
import { IManager, ManagerSchema } from '../managers/schemas/manager.schema';
import { removeEventMessengerData } from '../event-messengers/event-messengers.cleanup';
import { resetHomeHeroIfEvent } from '../home-hero/home-hero-links';

/*
 * Links of a deleted event that must go away, and the soft delete itself. Plain functions,
 * not a service: both delete paths use them — `AdminEventsService.deleteEvent` (AdminModule)
 * and `EventRemovalService` (EventsModule).
 */

function eventModel(): mongoose.Model<IEvent> {
  return (mongoose.models.Event as mongoose.Model<IEvent>) ?? mongoose.model<IEvent>('Event', EventSchema);
}

function managerModel(): mongoose.Model<IManager> {
  return (mongoose.models.Manager as mongoose.Model<IManager>) ?? mongoose.model<IManager>('Manager', ManagerSchema);
}

export type DeletedEventCleanup = { managersDetached: number; errors: string[] };

/**
 * Detaches managers from a deleted event, drops its messenger integrations and its home-screen
 * pin. Best effort: never throws, failures come back as codes (`managers_events_cleanup_failed`,
 * `managers_event_cleanup_failed`, `messengers_cleanup_failed`, `home_hero_cleanup_failed`)
 * and are logged with `context`.
 */
export async function cleanUpDeletedEventLinks(id: number, logger: Logger, context: string): Promise<DeletedEventCleanup> {
  const errors: string[] = [];
  let managersDetached = 0;
  // ManagersService.update/remove assert that every assigned event exists, so a stale id
  // would make the organizer's manager edit/delete fail with 404.
  try {
    const pulledManagerIds = await managerModel().distinct('id', { events: id }).exec();
    managersDetached += (await managerModel().updateMany({ events: id }, { $pull: { events: id } }).exec())
      .modifiedCount;
    // With `events` emptied, ManagersService falls back to the legacy `event` field,
    // which may still hold a stale unassigned event: drop it so no access comes back.
    if (pulledManagerIds.length) {
      await managerModel()
        .updateMany(
          { id: { $in: pulledManagerIds }, events: { $size: 0 }, event: { $exists: true } },
          { $unset: { event: 1 } },
        )
        .exec();
    }
  } catch (err) {
    errors.push('managers_events_cleanup_failed');
    logger.error(`Event ${id} deleted but managers.events was not cleaned (${context}): ${(err as Error).message}`);
  }
  try {
    managersDetached += (await managerModel().updateMany({ event: id }, { $unset: { event: 1 } }).exec())
      .modifiedCount;
  } catch (err) {
    errors.push('managers_event_cleanup_failed');
    logger.error(`Event ${id} deleted but managers.event was not cleaned (${context}): ${(err as Error).message}`);
  }
  // Messenger integrations hold channel credentials: they must not outlive the event.
  try {
    await removeEventMessengerData(id);
  } catch (err) {
    errors.push('messengers_cleanup_failed');
    logger.error(
      `Event ${id} deleted but its messenger integrations were not (${context}): ${(err as Error).message}`,
    );
  }
  // Pinned on the home screen: back to the default mode (the home-hero cron would do it later too).
  try {
    await resetHomeHeroIfEvent(id, 'event_deleted');
  } catch (err) {
    errors.push('home_hero_cleanup_failed');
    logger.error(`Event ${id} deleted but is still pinned on the home screen (${context}): ${(err as Error).message}`);
  }
  return { managersDetached, errors };
}

export type SoftDeleteOutcome = DeletedEventCleanup & {
  /** false: the event was already soft-deleted (repeat request) — nothing was written. */
  changed: boolean;
};

/**
 * Soft delete — used instead of a hard delete when the event has an ARBI Pay store
 * (arbipay-stores/arbipay-store-event-links.ts). The document, its sessions and every
 * reference stay; the event is marked `softDeleted` and archived, so every archive guard
 * applies (off the site, `event_hidden` for new orders, no organizer edits). The organizer
 * no longer sees it at all; the admin panel lists it with a «deleted» mark. The callers
 * check the blockers (sales, payouts) first — exactly as before a hard delete.
 * `by`: `admin:<id>`, `user:<id>` or `manager:<id>`. Idempotent.
 */
export async function softDeleteEvent(
  event: Pick<IEvent, 'id' | 'archivedByOrganizer'>,
  by: string,
  logger: Logger,
): Promise<SoftDeleteOutcome> {
  const now = new Date();
  const set: Record<string, unknown> = { softDeleted: true, softDeletedAt: now, softDeletedBy: by, archivedByOrganizer: true };
  // An event archived earlier keeps the stamp of that archive.
  if (event.archivedByOrganizer !== true) {
    set.archivedByOrganizerAt = now;
    set.archivedByOrganizerBy = by;
  }
  // `timestamps: false`: not an edit of the event, so `updatedAt` stays put.
  const { modifiedCount } = await eventModel()
    .updateOne({ id: event.id, softDeleted: { $ne: true } }, { $set: set }, { timestamps: false })
    .exec();
  if (modifiedCount === 0) {
    return { changed: false, managersDetached: 0, errors: [] };
  }
  const cleanup = await cleanUpDeletedEventLinks(event.id, logger, `soft delete by ${by}`);
  return { changed: true, ...cleanup };
}
