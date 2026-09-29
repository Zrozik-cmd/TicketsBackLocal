import { MULTI_PLACE_OBJECTS, NodeKind, SELLABLE_OBJECTS, SectorType } from '../constants/seating-plan.constants';

/** Сколько мест даёт объект: номерной стол и диван — свою вместимость, остальные — одно. */
export const objectPlaces = (node: any): number =>
  MULTI_PLACE_OBJECTS.includes(node?.objectType) ? Math.max(1, Math.trunc(Number(node.capacity) || 0)) : 1;

/**
 * Даёт ли объект места. Стол, стул, диван и места для МГН — да, если это не декор:
 * `decor: true` рисуется на схеме, но мест не даёт, во вместимость и зоны не входит,
 * а его `ticket` не читается. Единственная проверка на всё — места, итоги, публикацию.
 */
export const isSellableObject = (node: any): boolean =>
  node?.kind === NodeKind.OBJECT && SELLABLE_OBJECTS.includes(node.objectType) && node.decor !== true;

/** Стоячий сектор рядов и мест не имеет: продаётся количеством (`capacity`). */
export const isStandingSector = (node: any): boolean =>
  node?.kind === NodeKind.SECTOR && node.sectorType === SectorType.STANDING;
