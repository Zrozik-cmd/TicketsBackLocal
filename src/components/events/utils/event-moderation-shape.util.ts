import type { IEventSponsor } from '../schemas/event.schema';

/**
 * Moderation shape of an event: the fields an organizer edits and an admin reviews, in
 * canonical form. Every approval stores it in `event_approval_snapshots`; the admin detail
 * diffs that snapshot against the current event so a re-moderation highlights everything
 * changed since the last approval. Pure functions only (no Nest, no mongoose).
 *
 * Canonical form mirrors `EventsService.canonicalize` / `organizerSectorShape` (and the
 * organizer form's `canonicalizeForDiff`): sorted keys, `_id`/`__v` dropped,
 * `undefined`/`null`/`''` read as "not set", live sector counters ignored. Values are
 * picked field by field, so bookkeeping a stored document may carry never shows up as a change.
 */

/** Top-level fields of the shape, in the order the admin diff lists them. */
export const EVENT_MODERATION_FIELDS = [
  'title',
  'description',
  'eventLanguage',
  'category',
  'tags',
  'province',
  'city',
  'venue',
  'venueSchedule',
  'eventDate',
  'time',
  'recurrence',
  'sectors',
  'coverImage',
  'galleryImages',
  'seatingPlanImage',
  'seatingPlanSeats',
  'parkingPlanImage',
  'parkingPlanSeats',
  'externalLinks',
  'refundPolicy',
  'salesCloseBefore',
  'ticketCopyEmail',
  'paymentOptions',
  'hiddenFromSite',
  'ticketFormat',
  'sponsors',
] as const;

export type EventModerationField = (typeof EVENT_MODERATION_FIELDS)[number];

export type EventModerationShape = { [K in EventModerationField]?: unknown };

/** One changed top-level field; `null` stands for "not set". */
export type EventModerationChange = {
  field: EventModerationField;
  before: unknown;
  after: unknown;
};

/** Sponsor as stored and as compared: `logo` is a Media id. */
export type EventSponsorShape = Pick<IEventSponsor, 'id' | 'logo' | 'name' | 'url'>;

/** Payment options as an admin reviews them (cash switch + legacy THB receiver). */
export type EventPaymentOptionsSummary = {
  /** Same value the site uses: a THB block exists and `cashEnabled === true`. */
  cashEnabled: boolean;
  /** Legacy manual THB receiver; `null` when none of its fields is filled. */
  thb: {
    accountNumber: string;
    recipientName: string;
    phoneNumber: string;
    qrCodeImage: number | null;
  } | null;
};

/**
 * Which sponsor list goes into the shape: `approved` = `sponsors` (what tickets render, what
 * a snapshot stores); `current` = `pendingSponsors ?? sponsors` (the organizer's latest list).
 */
export type ModerationSponsorsSide = 'approved' | 'current';

/** Projection with every field `buildEventModerationShape` reads. */
export const EVENT_MODERATION_SOURCE_PROJECTION: Record<string, 1> = {
  id: 1,
  status: 1,
  createdAt: 1,
  updatedAt: 1,
  pendingSponsors: 1,
  ...Object.fromEntries(EVENT_MODERATION_FIELDS.map((field) => [field, 1])),
};

type PlainObject = Record<string, unknown>;

function asObject(value: unknown): PlainObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as PlainObject) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** A Media id (positive number, or a numeric string from very old documents). */
function asMediaId(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = Number.parseInt(value, 10);
    return parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

/** Canonical form of any value (see the file comment). */
export function canonicalizeModerationValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalizeModerationValue(item));
  if (value && typeof value === 'object') {
    const source = value as PlainObject;
    const result: PlainObject = {};
    for (const key of Object.keys(source).sort()) {
      if (key === '_id' || key === '__v') continue;
      const inner = source[key];
      if (inner === undefined || inner === null || inner === '') continue;
      result[key] = canonicalizeModerationValue(inner);
    }
    return result;
  }
  return value;
}

/** Ticket structure as the organizer submits it: no live `sold_tickets`/`remaining_tickets`. */
export function organizerSectorShape(sectors: unknown): unknown {
  if (!Array.isArray(sectors)) return sectors;
  return sectors.map((sector) => {
    const s = (asObject(sector) ?? {}) as PlainObject;
    const zones = Array.isArray(s.zones) ? s.zones : [];
    return {
      id: s.id,
      color: s.color,
      name: s.name,
      zones: zones.map((zone) => {
        const z = (asObject(zone) ?? {}) as PlainObject;
        return {
          id: z.id,
          name: z.name,
          seats: z.seats,
          isFree: z.isFree,
          price: z.price,
          currency: z.currency,
        };
      }),
    };
  });
}

/** A sponsor list reduced to `{ id, logo, name, url }` (absent strings become `''`). */
export function sponsorsShape(list: unknown): EventSponsorShape[] {
  if (!Array.isArray(list)) return [];
  return list.map((item) => {
    const s = asObject(item) ?? {};
    return {
      id: asString(s.id) ?? '',
      logo: asMediaId(s.logo) ?? 0,
      name: asString(s.name) ?? '',
      url: asString(s.url) ?? '',
    };
  });
}

/** Same sponsors in the same order (order is what the ticket shows, so it counts). */
export function sponsorListsEqual(a: unknown, b: unknown): boolean {
  return (
    JSON.stringify(canonicalizeModerationValue(sponsorsShape(a))) ===
    JSON.stringify(canonicalizeModerationValue(sponsorsShape(b)))
  );
}

/** Logo Media ids of a sponsor list. */
export function sponsorLogoIds(list: unknown): number[] {
  return sponsorsShape(list)
    .map((sponsor) => sponsor.logo)
    .filter((logo) => logo > 0);
}

/** `true` when any sponsor carries a non-empty link. */
export function sponsorsHaveLink(list: unknown): boolean {
  return sponsorsShape(list).some((sponsor) => sponsor.url.trim() !== '');
}

export function paymentOptionsSummary(paymentOptions: unknown): EventPaymentOptionsSummary {
  const options = asObject(paymentOptions) ?? {};
  const thb = asObject(options.thb);
  const receiver = thb
    ? {
        accountNumber: asString(thb.accountNumber) ?? '',
        recipientName: asString(thb.recipientName) ?? '',
        phoneNumber: asString(thb.phoneNumber) ?? '',
        qrCodeImage: asMediaId(thb.qrCodeImage) ?? null,
      }
    : null;
  const receiverFilled = Boolean(
    receiver &&
      (receiver.accountNumber || receiver.recipientName || receiver.phoneNumber || receiver.qrCodeImage),
  );
  return {
    cashEnabled: Boolean(thb) && options.cashEnabled === true,
    thb: receiverFilled ? receiver : null,
  };
}

function localizedShape(value: unknown): unknown {
  const text = asObject(value);
  if (!text) return undefined;
  return { th: asString(text.th), en: asString(text.en), ru: asString(text.ru) };
}

function idLabelShape(value: unknown): unknown {
  const item = asObject(value);
  if (!item) return undefined;
  return { id: asString(item.id), label: asString(item.label) };
}

function recurrenceShape(value: unknown): unknown {
  const recurrence = asObject(value);
  // `enabled: false` means the schedule was dropped: the event is a one-off.
  if (!recurrence || recurrence.enabled !== true) return undefined;
  return {
    enabled: true,
    periodStart: asString(recurrence.periodStart),
    periodEnd: asString(recurrence.periodEnd),
    weekdays: Array.isArray(recurrence.weekdays) ? recurrence.weekdays : [],
    sessions: (Array.isArray(recurrence.sessions) ? recurrence.sessions : []).map((session) => {
      const s = asObject(session) ?? {};
      return { start: asString(s.start), end: asString(s.end) };
    }),
    stepMinutes: asNumber(recurrence.stepMinutes),
    exceptions: Array.isArray(recurrence.exceptions) ? recurrence.exceptions : [],
  };
}

/**
 * Builds the canonical moderation shape of a plain event (lean document, `toObject()` or
 * an admin projection). `sponsorsSide` picks the sponsor list, see `ModerationSponsorsSide`.
 */
export function buildEventModerationShape(
  event: unknown,
  sponsorsSide: ModerationSponsorsSide = 'approved',
): EventModerationShape {
  const e = asObject(event) ?? {};
  const eventDate = asObject(e.eventDate);
  const time = asObject(e.time);
  const venue = asObject(e.venue);
  const salesCloseBefore = asObject(e.salesCloseBefore);
  const sponsors =
    sponsorsSide === 'current' && Array.isArray(e.pendingSponsors) ? e.pendingSponsors : e.sponsors;

  const shape: Record<EventModerationField, unknown> = {
    title: localizedShape(e.title),
    description: localizedShape(e.description),
    eventLanguage: asString(e.eventLanguage),
    category: idLabelShape(e.category),
    tags: (Array.isArray(e.tags) ? e.tags : []).map(idLabelShape),
    province: idLabelShape(e.province),
    city: asString(e.city),
    venue: venue
      ? {
          name: asString(venue.name),
          address: asString(venue.address),
          placeId: asString(venue.placeId),
          lat: asNumber(venue.lat),
          lng: asNumber(venue.lng),
        }
      : undefined,
    venueSchedule: asString(e.venueSchedule),
    eventDate: eventDate
      ? {
          isRange: asBoolean(eventDate.isRange),
          startDate: asString(eventDate.startDate),
          endDate: asString(eventDate.endDate),
        }
      : undefined,
    time: time
      ? { allDay: asBoolean(time.allDay), start: asString(time.start), end: asString(time.end) }
      : undefined,
    recurrence: recurrenceShape(e.recurrence),
    sectors: organizerSectorShape(Array.isArray(e.sectors) ? e.sectors : []),
    coverImage: asMediaId(e.coverImage),
    galleryImages: (Array.isArray(e.galleryImages) ? e.galleryImages : [])
      .map(asMediaId)
      .filter((id): id is number => id !== undefined),
    seatingPlanImage: asMediaId(e.seatingPlanImage),
    seatingPlanSeats: asNumber(e.seatingPlanSeats),
    parkingPlanImage: asMediaId(e.parkingPlanImage),
    parkingPlanSeats: asNumber(e.parkingPlanSeats),
    externalLinks: (Array.isArray(e.externalLinks) ? e.externalLinks : []).map((link) => {
      const l = asObject(link) ?? {};
      return {
        id: asString(l.id),
        platform: asString(l.platform),
        displayName: asString(l.displayName),
        url: asString(l.url),
      };
    }),
    refundPolicy: localizedShape(e.refundPolicy),
    salesCloseBefore: salesCloseBefore
      ? {
          enabled: asBoolean(salesCloseBefore.enabled),
          value: asNumber(salesCloseBefore.value),
          unit: asString(salesCloseBefore.unit),
        }
      : undefined,
    ticketCopyEmail: asString(e.ticketCopyEmail),
    paymentOptions: paymentOptionsSummary(e.paymentOptions),
    hiddenFromSite: e.hiddenFromSite === true,
    ticketFormat: e.ticketFormat === 'pdf' ? 'pdf' : 'webp',
    sponsors: sponsorsShape(sponsors),
  };
  return canonicalizeModerationValue(shape) as EventModerationShape;
}

/**
 * Top-level fields whose canonical JSON differs, in `EVENT_MODERATION_FIELDS` order. Both
 * sides are canonicalized again, so a stored snapshot's key order never matters.
 */
export function diffEventModerationShapes(before: unknown, after: unknown): EventModerationChange[] {
  const b = (asObject(canonicalizeModerationValue(before ?? {})) ?? {}) as PlainObject;
  const a = (asObject(canonicalizeModerationValue(after ?? {})) ?? {}) as PlainObject;
  const changes: EventModerationChange[] = [];
  for (const field of EVENT_MODERATION_FIELDS) {
    if (JSON.stringify(b[field]) !== JSON.stringify(a[field])) {
      changes.push({ field, before: b[field] ?? null, after: a[field] ?? null });
    }
  }
  return changes;
}
