import { Injectable, Logger } from '@nestjs/common';
import mongoose from 'mongoose';
import { EventSchema, type IEvent } from './schemas/event.schema';
import {
  EventApprovalSnapshotSchema,
  type IEventApprovalSnapshot,
} from './schemas/event-approval-snapshot.schema';
import type { EventStatus } from './constants/event-status.constant';
import {
  buildEventModerationShape,
  EVENT_MODERATION_SOURCE_PROJECTION,
  paymentOptionsSummary,
  sponsorsShape,
  type EventModerationField,
  type EventSponsorShape,
} from './utils/event-moderation-shape.util';

/**
 * Statuses only an admin approval leads to: boot-time baselines are written for these, and only
 * these events can have their pending sponsors approved on their own.
 */
export const APPROVED_EVENT_STATUSES: readonly EventStatus[] = ['ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED'];

/** Approval snapshots (`event_approval_snapshots`), see `IEventApprovalSnapshot`. */
@Injectable()
export class EventApprovalSnapshotsService {
  private readonly logger = new Logger(EventApprovalSnapshotsService.name);

  private get snapshotModel(): mongoose.Model<IEventApprovalSnapshot> {
    return (
      (mongoose.models.EventApprovalSnapshot as mongoose.Model<IEventApprovalSnapshot>) ??
      mongoose.model<IEventApprovalSnapshot>('EventApprovalSnapshot', EventApprovalSnapshotSchema)
    );
  }

  private get eventModel(): mongoose.Model<IEvent> {
    return (mongoose.models.Event as mongoose.Model<IEvent>) ?? mongoose.model<IEvent>('Event', EventSchema);
  }

  /**
   * Baselines for events published before snapshots existed: without one, the admin has
   * nothing to diff against and organizer sponsor edits of a live event would skip review.
   * Idempotent per event (`$setOnInsert`, events that have a snapshot are skipped), so a
   * crash or a second process only fills gaps. Per-event errors are logged and counted.
   *
   * Run at boot by `EventsService.onApplicationBootstrap` after its own backfills (not from a
   * hook here: Nest runs one module's hooks concurrently, and a baseline read before the city
   * backfill would show `city` as changed forever). `normalize` turns a stored event into the
   * state the admin detail diffs against (`EventsService.ensureEventMediaIds`); the stored
   * document is used when it fails.
   */
  async backfillBaselines(
    normalize?: (event: unknown) => Promise<unknown>,
  ): Promise<{ scanned: number; created: number; failed: number }> {
    const withSnapshot = new Set<number>(
      ((await this.snapshotModel.distinct('eventId').exec()) as unknown[]).filter(
        (id): id is number => typeof id === 'number',
      ),
    );
    const cursor = this.eventModel
      .find({ status: { $in: [...APPROVED_EVENT_STATUSES] } })
      // `creator`: `normalize` stores a legacy data-URL image as a Media of the organizer.
      .select({ ...EVENT_MODERATION_SOURCE_PROJECTION, creator: 1 })
      .lean()
      .cursor();
    let scanned = 0;
    let created = 0;
    let failed = 0;
    for await (const doc of cursor) {
      const event = doc as unknown as { id?: unknown; updatedAt?: Date; createdAt?: Date };
      scanned += 1;
      if (typeof event.id !== 'number' || withSnapshot.has(event.id)) continue;
      try {
        const source = normalize ? await normalize(doc).catch(() => doc) : doc;
        const res = await this.snapshotModel
          .updateOne(
            { eventId: event.id },
            {
              $setOnInsert: {
                approvedAt: event.updatedAt ?? event.createdAt ?? new Date(),
                approvedByAdminId: null,
                data: buildEventModerationShape(source, 'approved'),
              },
            },
            { upsert: true },
          )
          .exec();
        if (res.upsertedCount) created += 1;
      } catch (error) {
        failed += 1;
        this.logger.error(
          `Event approval baseline for event ${event.id} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return { scanned, created, failed };
  }

  async findByEventId(eventId: number): Promise<IEventApprovalSnapshot | null> {
    return (await this.snapshotModel.findOne({ eventId }).lean().exec()) as IEventApprovalSnapshot | null;
  }

  /** Whether the event was approved at least once — sponsor changes then wait for an admin. */
  async hasSnapshot(eventId: number): Promise<boolean> {
    return (await this.snapshotModel.exists({ eventId }).exec()) != null;
  }

  /** Approved sponsors recorded in a snapshot (`[]` without one). */
  sponsorsOf(snapshot: Pick<IEventApprovalSnapshot, 'data'> | null | undefined): EventSponsorShape[] {
    return sponsorsShape(snapshot?.data?.sponsors);
  }

  /** Replaces the event's snapshot with its state right after an approval. */
  async writeApproval(
    event: { id: number },
    approvedByAdminId: number | null,
    approvedAt: Date = new Date(),
  ): Promise<void> {
    await this.snapshotModel
      .updateOne(
        { eventId: event.id },
        {
          $set: {
            approvedAt,
            approvedByAdminId,
            data: buildEventModerationShape(event, 'approved'),
          },
        },
        { upsert: true },
      )
      .exec();
  }

  /**
   * An admin edited reviewed fields: copy them from `event` into the existing snapshot, so the
   * edit never reads as an organizer change. No snapshot, nothing to do. Returns whether one
   * was updated.
   */
  async syncAdminEdit(
    eventId: number,
    event: unknown,
    fields: readonly EventModerationField[],
  ): Promise<boolean> {
    const shape = buildEventModerationShape(event, 'approved');
    const $set: Record<string, unknown> = {};
    const $unset: Record<string, 1> = {};
    for (const field of fields) {
      if (shape[field] === undefined) {
        $unset[`data.${field}`] = 1;
      } else {
        $set[`data.${field}`] = shape[field];
      }
    }
    const update: mongoose.UpdateQuery<IEventApprovalSnapshot> = {};
    if (Object.keys($set).length) update.$set = $set;
    if (Object.keys($unset).length) update.$unset = $unset;
    if (!update.$set && !update.$unset) return false;
    const res = await this.snapshotModel.updateOne({ eventId }, update).exec();
    return res.matchedCount > 0;
  }

  /**
   * The admin cash switch: only `paymentOptions.cashEnabled` of the snapshot follows `event`
   * (the legacy THB receiver stays as approved). Returns whether a snapshot was updated.
   */
  async syncAdminCashEnabled(eventId: number, event: { paymentOptions?: unknown } | null): Promise<boolean> {
    const { cashEnabled } = paymentOptionsSummary(event?.paymentOptions);
    const res = await this.snapshotModel
      .updateOne({ eventId }, { $set: { 'data.paymentOptions.cashEnabled': cashEnabled } })
      .exec();
    return res.matchedCount > 0;
  }

  /** Removes one sponsor from the snapshot's approved list; returns the logo ids it carried. */
  async removeSponsor(eventId: number, sponsorId: string): Promise<number[]> {
    const before = (await this.snapshotModel
      .findOneAndUpdate(
        { eventId, 'data.sponsors.id': sponsorId },
        { $pull: { 'data.sponsors': { id: sponsorId } } },
        { new: false },
      )
      .lean()
      .exec()) as IEventApprovalSnapshot | null;
    return this.sponsorsOf(before)
      .filter((sponsor) => sponsor.id === sponsorId && sponsor.logo > 0)
      .map((sponsor) => sponsor.logo);
  }
}
