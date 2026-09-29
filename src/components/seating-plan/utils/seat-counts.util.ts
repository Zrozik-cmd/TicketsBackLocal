import { expandSector, resolveTicket } from './expand.util';
import { isStandingSector } from './object-places.util';

/** Итоги Live Review: места по классу билета и по типу кресла. */
export type SeatCounts = { byCategory: Record<string, number>; bySeatType: Record<string, number> };

export const emptySeatCounts = (): SeatCounts => ({ byCategory: {}, bySeatType: {} });

const add = (bucket: Record<string, number>, key: string, count: number) => {
  bucket[key] = (bucket[key] || 0) + count;
};

/**
 * Собственные места сектора (без вложенных объектов) — в итоги. Место ряда идёт в каждый
 * свой класс и в свой тип кресла, выключенное не считается. Стоячий сектор рядов не имеет:
 * вся его вместимость идёт в классы сектора, типа кресла у неё нет.
 */
export function addSectorSeatCounts(counts: SeatCounts, sector: any, rows: any[], seats: any[]): SeatCounts {
  if (isStandingSector(sector)) {
    const capacity = Math.max(0, Math.trunc(Number(sector.capacity) || 0));
    if (capacity) (resolveTicket(sector).categories || []).forEach((category) => add(counts.byCategory, category, capacity));
    return counts;
  }

  expandSector(sector, rows, seats).forEach((row) =>
    row.seats.forEach((seat) => {
      if (seat.disabled) return;
      (seat.ticket.categories || []).forEach((category) => add(counts.byCategory, category, 1));
      if (seat.seatType) add(counts.bySeatType, seat.seatType, 1);
    }),
  );
  return counts;
}
