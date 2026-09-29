import { ObjectType } from '../constants/seating-plan.constants';
import { ROWS_SOURCE } from './price-groups.util';
import type { Localized } from './plan-categories.util';

/** Подписи мест-объектов в названии зоны. */
const OBJECT_TITLES: Record<string, Localized> = {
  [ObjectType.ADD_CHAIR]: { th: 'เก้าอี้', en: 'Chair', ru: 'Стул' },
  [ObjectType.ADD_SOFA]: { th: 'โซฟา', en: 'Sofa', ru: 'Диван' },
  [ObjectType.ADD_TABLE]: { th: 'โต๊ะ', en: 'Table', ru: 'Стол' },
  [ObjectType.DISABLED_SEATS]: { th: 'ที่นั่งสำหรับผู้พิการ', en: 'Accessible seat', ru: 'Место для МГН' },
};

/** Сектор события для стульев, диванов и столов, стоящих вне секторов схемы. */
export const SEPARATE_SEATS_TITLE: Localized = { th: 'ที่นั่งแยก', en: 'Separate seats', ru: 'Отдельные места' };

type ZoneGroup = {
  source: string;
  price: number;
  seatsCount: number;
  objectId?: number | null;
  tableNumber?: number | null;
};

/**
 * Подпись зоны: класс билета для мест рядов («VIP»), тип объекта с классом для
 * стульев и диванов («Sofa · VIP»), номер и вместимость для номерного стола.
 * `category` — уже готовая подпись категории (categoryTitle).
 */
export function zoneTitle(group: ZoneGroup, category: Localized, withPrice: boolean): Localized {
  const price = withPrice ? ` · ${group.price} THB` : '';

  if (group.objectId != null) {
    const n = group.tableNumber ?? group.objectId;
    const seats = group.seatsCount;
    return {
      th: `โต๊ะ ${n} (${seats} ที่นั่ง) · ${category.th}`,
      en: `Table ${n} (${seats} seats) · ${category.en}`,
      ru: `Стол ${n} (${seats} мест) · ${category.ru}`,
    };
  }
  if (group.source !== ROWS_SOURCE) {
    const object = OBJECT_TITLES[group.source] ?? OBJECT_TITLES[ObjectType.ADD_CHAIR];
    return {
      th: `${object.th} · ${category.th}${price}`,
      en: `${object.en} · ${category.en}${price}`,
      ru: `${object.ru} · ${category.ru}${price}`,
    };
  }
  return { th: category.th + price, en: category.en + price, ru: category.ru + price };
}
