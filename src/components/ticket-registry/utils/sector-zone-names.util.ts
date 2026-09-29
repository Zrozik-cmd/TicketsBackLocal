import type { IEvent, ILocalizedText } from '../../events/schemas/event.schema';

export type OrganizerNameLocale = 'en' | 'ru' | 'th';

/** The text in `locale`, then English, then any other language; `fallback` when all are blank. */
export function pickLocalizedName(
  value: ILocalizedText | undefined,
  locale: OrganizerNameLocale,
  fallback: string,
): string {
  const order: OrganizerNameLocale[] =
    locale === 'th' ? ['th', 'en', 'ru'] : locale === 'ru' ? ['ru', 'en', 'th'] : ['en', 'th', 'ru'];
  for (const key of order) {
    const text = value?.[key]?.trim();
    if (text) return text;
  }
  return fallback;
}

/**
 * Localized sector / zone names of the event for organizer lists. Tickets and order lines
 * only carry the ids; an id the event no longer has is shown as is.
 */
export function buildSectorZoneNames(
  event: Pick<IEvent, 'sectors'>,
  locale: OrganizerNameLocale,
): { sectorName: (sectorId: string) => string; zoneName: (sectorId: string, zoneId: string) => string } {
  const sectorNames = new Map<string, string>();
  const zoneNames = new Map<string, string>();
  for (const sector of event.sectors ?? []) {
    sectorNames.set(sector.id, pickLocalizedName(sector.name, locale, sector.id));
    for (const zone of sector.zones ?? []) {
      zoneNames.set(`${sector.id}::${zone.id}`, pickLocalizedName(zone.name, locale, zone.id));
    }
  }
  return {
    sectorName: (sectorId) => sectorNames.get(sectorId) ?? sectorId,
    zoneName: (sectorId, zoneId) => zoneNames.get(`${sectorId}::${zoneId}`) ?? zoneId,
  };
}
