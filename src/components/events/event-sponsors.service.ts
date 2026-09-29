import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import mongoose from 'mongoose';
import { MediaService } from '../media/media.service';
import { EventSchema, type EventTicketFormat, type IEvent, type IEventSponsor } from './schemas/event.schema';
import { EventApprovalSnapshotsService } from './event-approval-snapshots.service';
import { EVENT_SPONSOR_ERROR } from './constants/event-sponsors.constant';
import { parseSponsorLogoDataUrl } from './utils/event-sponsors.util';
import { sponsorLogoIds, sponsorsHaveLink } from './utils/event-moderation-shape.util';

/** A sponsor as the admin submits it (`EventSponsorDto`). */
export type SubmittedEventSponsor = {
  id: string;
  logo: { mediaId?: number; image?: { url: string } };
  name?: string;
  url?: string;
};

type SponsorsHolder = Pick<IEvent, 'id' | 'sponsors' | 'pendingSponsors' | 'pendingSponsorsAt' | 'ticketFormat'>;

/** Result of `prepareSave`: what the rest of the save needs. */
export type SponsorsSave = {
  /** The validated submitted list; `undefined` when the request leaves sponsors alone. */
  entries?: SubmittedEventSponsor[];
};

/** `$set` / `$unset` parts a sponsors save adds. */
export type SponsorsUpdateParts = {
  $set: Record<string, unknown>;
  $unset: Record<string, 1>;
};

/**
 * Event sponsors (see `constants/event-sponsors.constant.ts`): validation and upload of the
 * list an admin saves, the write it turns into, and the logo clean-up the admin actions share.
 */
@Injectable()
export class EventSponsorsService {
  private readonly logger = new Logger(EventSponsorsService.name);

  constructor(
    private readonly mediaService: MediaService,
    private readonly approvalSnapshots: EventApprovalSnapshotsService,
  ) {}

  private get eventModel(): mongoose.Model<IEvent> {
    return (mongoose.models.Event as mongoose.Model<IEvent>) ?? mongoose.model<IEvent>('Event', EventSchema);
  }

  /**
   * Validates a save before anything is uploaded or written. `sponsors`/`ticketFormat` `null`
   * or `undefined` = not sent.
   * - 400 `ticket_format_pdf_required`: a sponsor link with an effective format other than
   *   PDF. Effective format = sent ?? stored ?? 'webp'; the list checked is the submitted one,
   *   or the event's current one (`pendingSponsors ?? sponsors`) when only the format is sent.
   * - 400 `sponsor_id_duplicate`: two sponsors share an id.
   * - 400 `sponsor_logo_invalid`: a new logo is not an accepted image, or a kept `mediaId` is not
   *   a logo of this event (approved, pending or in the approval snapshot).
   */
  async prepareSave(
    existing: SponsorsHolder,
    sponsors: SubmittedEventSponsor[] | null | undefined,
    ticketFormat: EventTicketFormat | null | undefined,
  ): Promise<SponsorsSave> {
    if (sponsors == null && ticketFormat == null) {
      return {};
    }
    const effectiveFormat = ticketFormat ?? existing.ticketFormat ?? 'webp';
    const formatList = sponsors ?? existing.pendingSponsors ?? existing.sponsors ?? [];
    if (effectiveFormat !== 'pdf' && sponsorsHaveLink(formatList)) {
      throw new BadRequestException(EVENT_SPONSOR_ERROR.TICKET_FORMAT_PDF_REQUIRED);
    }
    if (sponsors == null) {
      return {};
    }
    const snapshot = await this.approvalSnapshots.findByEventId(existing.id);

    const ids = new Set<string>();
    for (const sponsor of sponsors) {
      if (ids.has(sponsor.id)) {
        throw new BadRequestException(EVENT_SPONSOR_ERROR.DUPLICATE_ID);
      }
      ids.add(sponsor.id);
    }

    const ownLogos = new Set<number>([
      ...sponsorLogoIds(existing.sponsors),
      ...sponsorLogoIds(existing.pendingSponsors),
      ...sponsorLogoIds(this.approvalSnapshots.sponsorsOf(snapshot)),
    ]);
    for (const sponsor of sponsors) {
      const { mediaId, image } = sponsor.logo ?? {};
      const valid = image
        ? parseSponsorLogoDataUrl(image.url) !== null
        : typeof mediaId === 'number' && ownLogos.has(mediaId);
      if (!valid) {
        throw new BadRequestException(EVENT_SPONSOR_ERROR.LOGO_INVALID);
      }
    }
    return { entries: sponsors };
  }

  /**
   * Uploads the new logos (public Media, MIME type from the checked data URL, never from the
   * client's `mimeType`) and returns the list as stored. Call after `prepareSave`.
   */
  async resolveSubmittedSponsors(
    entries: SubmittedEventSponsor[],
    creator: number,
  ): Promise<IEventSponsor[]> {
    const list: IEventSponsor[] = [];
    for (const entry of entries) {
      let logo: number;
      if (entry.logo.image) {
        const parsed = parseSponsorLogoDataUrl(entry.logo.image.url);
        if (!parsed) {
          throw new BadRequestException(EVENT_SPONSOR_ERROR.LOGO_INVALID);
        }
        logo = await this.mediaService.createFromDataUrl(entry.logo.image.url, creator, parsed.mimeType);
      } else {
        logo = entry.logo.mediaId as number;
      }
      list.push({
        id: entry.id,
        logo,
        name: (entry.name ?? '').trim(),
        url: (entry.url ?? '').trim(),
      });
    }
    return list;
  }

  /**
   * The write an admin save turns into: the submitted list *is* what tickets render, so it
   * goes straight into `sponsors` (an empty list removes the block) together with the chosen
   * e-mail format. Any organizer list still waiting from before the block moved to the admin
   * panel is dropped — the admin has just decided what the event shows.
   */
  adminSaveUpdate(list: IEventSponsor[], ticketFormat: EventTicketFormat): SponsorsUpdateParts {
    const parts: SponsorsUpdateParts = { $set: {}, $unset: {} };
    if (list.length) {
      parts.$set.sponsors = list;
    } else {
      parts.$unset.sponsors = 1;
    }
    parts.$set.ticketFormat = ticketFormat;
    parts.$unset.pendingSponsors = 1;
    parts.$unset.pendingSponsorsAt = 1;
    return parts;
  }

  /**
   * Deletes the candidate logo Media that neither the event's `sponsors`, its `pendingSponsors`
   * nor its approval snapshot references (all re-read now). Best effort: failures are logged.
   * Nothing is deleted when the event is gone (the deleted-event archive may still need it).
   */
  async removeUnreferencedLogos(eventId: number, candidates: number[]): Promise<number[]> {
    const unique = [...new Set(candidates.filter((id) => Number.isInteger(id) && id > 0))];
    if (!unique.length) return [];
    try {
      const [event, snapshot] = await Promise.all([
        this.eventModel
          .findOne({ id: eventId })
          .select({ sponsors: 1, pendingSponsors: 1 })
          .lean()
          .exec() as Promise<Pick<IEvent, 'sponsors' | 'pendingSponsors'> | null>,
        this.approvalSnapshots.findByEventId(eventId),
      ]);
      if (!event) return [];
      const referenced = new Set<number>([
        ...sponsorLogoIds(event.sponsors),
        ...sponsorLogoIds(event.pendingSponsors),
        ...sponsorLogoIds(this.approvalSnapshots.sponsorsOf(snapshot)),
      ]);
      const removed: number[] = [];
      for (const id of unique) {
        if (referenced.has(id)) continue;
        await this.mediaService.removeById(id);
        removed.push(id);
      }
      return removed;
    } catch (error) {
      this.logger.error(
        `Sponsor logo clean-up for event ${eventId} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  }
}
