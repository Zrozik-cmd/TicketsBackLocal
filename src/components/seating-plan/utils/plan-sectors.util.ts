import { PLAN_SECTOR_ID_PREFIX } from '../constants/seating-plan.constants';

export const isPlanSectorId = (id: unknown) => String(id ?? '').startsWith(PLAN_SECTOR_ID_PREFIX);

type Localized = { th?: string; en?: string; ru?: string };
type SectorLike = { id: string; color?: string; name?: Localized; zones?: any[] };

const text = (value?: Localized) => ({ th: value?.th ?? '', en: value?.en ?? '', ru: value?.ru ?? '' });

/**
 * Секторы схемы зала (`plan-…`) пишет только публикация схемы. Сохранение события
 * организатором их не трогает: присланные `plan-…` отбрасываются, а текущие из базы
 * остаются как есть. Иначе форма, открытая до публикации, стирала секторы схемы, и места
 * на схеме оставались без зон, через которые продаются.
 */
export function keepPlanSectors<T extends { id: string }>(incoming: T[], current: SectorLike[]): Array<T | SectorLike> {
  const plan = current
    .filter((sector) => isPlanSectorId(sector.id))
    .map((sector) => ({
      id: sector.id,
      color: sector.color ?? '',
      name: text(sector.name),
      zones: (sector.zones ?? []).map((zone) => ({
        id: zone.id,
        name: text(zone.name),
        seats: zone.seats,
        isFree: Boolean(zone.isFree),
        price: zone.price,
        currency: zone.currency ?? 'THB',
      })),
    }));
  return [...incoming.filter((sector) => !isPlanSectorId(sector.id)), ...plan];
}
