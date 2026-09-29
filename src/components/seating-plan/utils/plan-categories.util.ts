import { TicketCategory } from '../constants/seating-plan.constants';

export type Localized = { th: string; en: string; ru: string };

/** Категория билета проекта: название (у стандартной может быть пустым) и цвет #rrggbb. */
export type PlanCategory = { id: string; name: string | null; color: string };

export const PLAN_CATEGORY_LIMITS = { count: 50, id: 40, name: 40 };
export const PLAN_CATEGORY_ID_PATTERN = /^[a-z0-9_]+$/i;
export const PLAN_CATEGORY_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

/** Подписи стандартных классов на трёх языках витрины. */
export const CATEGORY_TITLES: Record<string, Localized> = {
  [TicketCategory.ECONOMY]: { th: 'ชั้นประหยัด', en: 'Economy class', ru: 'Эконом класс' },
  [TicketCategory.BUSINESS]: { th: 'ชั้นธุรกิจ', en: 'Business class', ru: 'Бизнес класс' },
  [TicketCategory.VIP]: { th: 'VIP', en: 'VIP', ru: 'VIP' },
};

/**
 * Список категорий из запроса в вид для хранения: без повторов id, с обрезанным
 * названием; пустое название — null (у стандартной это «перевод по умолчанию»).
 * Формат полей уже проверен DTO — здесь только нормализация.
 */
export function normalizePlanCategories(list: unknown): PlanCategory[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const result: PlanCategory[] = [];
  list.forEach((item: any) => {
    const id = typeof item?.id === 'string' ? item.id.trim() : '';
    if (!id || seen.has(id)) return;
    seen.add(id);
    const name = typeof item.name === 'string' ? item.name.trim().slice(0, PLAN_CATEGORY_LIMITS.name) : '';
    result.push({ id, name: name || null, color: String(item.color).toLowerCase() });
  });
  return result.slice(0, PLAN_CATEGORY_LIMITS.count);
}

/**
 * Подпись категории для зоны события. Своё название категории — одно на все языки;
 * стандартный класс без своего названия — перевод; неизвестная категория — как эконом
 * (так было и до своих категорий).
 */
export function categoryTitle(categoryId: string, categories: PlanCategory[] | null | undefined): Localized {
  const own = (categories ?? []).find((item) => item.id === categoryId);
  if (own?.name) return { th: own.name, en: own.name, ru: own.name };
  return CATEGORY_TITLES[categoryId] ?? CATEGORY_TITLES[TicketCategory.ECONOMY];
}
