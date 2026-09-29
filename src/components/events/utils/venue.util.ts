import type { IVenue } from '../schemas/event.schema';

/**
 * Что показывать как площадку.
 *
 * Раньше существовало одно поле `address`, в которое писали то красивое
 * название («Laguna Grand Hall, Phuket»), то сырой адрес из Google, то
 * координаты — отсюда и разнобой на витрине. Теперь название хранится
 * отдельно, а для событий, созданных до этого, подписью остаётся адрес.
 */
export function venueLabel(venue?: Pick<IVenue, 'name' | 'address'> | null): string {
  const name = venue?.name?.trim();
  if (name) return name;
  return venue?.address?.trim() ?? '';
}

/** Адрес площадки; пусто, если организатор указал только название. */
export function venueAddress(venue?: Pick<IVenue, 'address'> | null): string {
  return venue?.address?.trim() ?? '';
}

/**
 * Название и адрес одной строкой — для писем и PDF-билета, где нет места
 * под два поля. Дубль не печатаем: у старых событий это одна и та же строка.
 */
export function venueOneLine(venue?: Pick<IVenue, 'name' | 'address'> | null): string {
  const label = venueLabel(venue);
  const address = venueAddress(venue);
  if (!label) return address;
  if (!address || address === label) return label;
  return `${label}, ${address}`;
}
