import { MULTI_PLACE_OBJECTS } from '../constants/seating-plan.constants';

/** Сколько мест даёт объект: номерной стол и диван — свою вместимость, остальные — одно. */
export const objectPlaces = (node: any): number =>
  MULTI_PLACE_OBJECTS.includes(node?.objectType) ? Math.max(1, Math.trunc(Number(node.capacity) || 0)) : 1;
