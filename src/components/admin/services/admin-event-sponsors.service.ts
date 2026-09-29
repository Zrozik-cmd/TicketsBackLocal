import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import mongoose from 'mongoose';
import { EventSchema, type EventTicketFormat, type IEvent } from '../../events/schemas/event.schema';
import { EventSponsorsService } from '../../events/event-sponsors.service';
import { EventApprovalSnapshotsService } from '../../events/event-approval-snapshots.service';
import { sponsorLogoIds } from '../../events/utils/event-moderation-shape.util';
import { toUpdateQuery, updateEventGuarded } from '../utils/admin-event-guarded-update.util';
import type { UpdateEventSponsorsDto } from '../dto/update-event-sponsors.dto';

/**
 * Sponsors & partners of an event as an **admin** maintains them: the "Sponsored by" block of
 * the ticket is filled in the admin panel, not by the organizer, so an admin save goes straight
 * onto the tickets (no moderation step) — see `events/constants/event-sponsors.constant.ts`.
 *
 * Validation is `EventSponsorsService.prepareSave`, the very same rules the organizer form used
 * before the block moved here (400 `ticket_format_pdf_required`, `sponsor_id_duplicate`,
 * `sponsor_logo_invalid`), so nothing about what a sponsor may be has changed.
 */
@Injectable()
export class AdminEventSponsorsService {
  private readonly logger = new Logger(AdminEventSponsorsService.name);

  constructor(
    private readonly eventSponsors: EventSponsorsService,
    private readonly approvalSnapshots: EventApprovalSnapshotsService,
  ) {}

  private get eventModel(): mongoose.Model<IEvent> {
    return (mongoose.models.Event as mongoose.Model<IEvent>) ?? mongoose.model<IEvent>('Event', EventSchema);
  }

  /**
   * Replaces the event's sponsor list (and the e-mail ticket format) with the submitted one.
   * Whatever the event's status is: the block is admin content, a save never sends the event
   * back to moderation and never changes what it sells.
   *
   * Order matters — validate, upload the new logos, then one guarded write, so a refusal
   * leaves neither half-uploaded media nor a half-written list. Afterwards the approval
   * snapshot follows the edit (invariant G: an admin write must never read as an organizer
   * change) and logos nothing references any more are deleted; both are best effort, the save
   * itself has already landed.
   */
  async replaceSponsors(
    eventId: number,
    dto: UpdateEventSponsorsDto,
    adminId?: string,
  ): Promise<void> {
    const existing = (await this.eventModel.findOne({ id: eventId }).lean().exec()) as IEvent | null;
    if (!existing) {
      throw new NotFoundException('Event not found');
    }
    const format: EventTicketFormat = dto.ticketFormat ?? existing.ticketFormat ?? 'webp';
    const prepared = await this.eventSponsors.prepareSave(existing, dto.sponsors, format);
    // The logo Media belongs to the organizer, like every other image of the event.
    const list = await this.eventSponsors.resolveSubmittedSponsors(
      prepared.entries ?? [],
      existing.creator,
    );
    const parts = this.eventSponsors.adminSaveUpdate(list, format);

    const { before, after } = await updateEventGuarded(this.eventModel, eventId, {}, () =>
      toUpdateQuery(parts.$set, parts.$unset),
    );

    try {
      await this.approvalSnapshots.syncAdminEdit(eventId, after, ['sponsors', 'ticketFormat']);
    } catch (err) {
      this.logger.error(
        `Approval snapshot of event ${eventId} did not follow the sponsor edit: ${(err as Error).message}`,
      );
    }
    await this.eventSponsors.removeUnreferencedLogos(eventId, [
      ...sponsorLogoIds(before.sponsors),
      ...sponsorLogoIds(before.pendingSponsors),
    ]);
    this.logger.log(`Sponsors of event ${eventId} saved by adminId=${adminId} (${list.length})`);
  }
}
