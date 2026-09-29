/**
 * Число мест в ряду фигурного сектора — та же формула, что рисует холст конструктора
 * (фронт, `app/seating-plan/seating.ts`). Без неё у трапеции, круга, полукруга и угла
 * бек заводил бы ряды по `seatsPerRow` целиком и продавал бы мест больше, чем нарисовано.
 * Доли ширины ряда сняты с фреймов Figma: круг 5-6-7-8-9-9-8-7-6-5, полукруг 5→9,
 * трапеция 30%→100%, угол — верхняя половина рядов по 40%.
 */
const CIRCLE_EDGE = 5 / 9;
const TRAPEZOID_TOP = 0.3;
const CORNER_SHORT = 0.4;

function rowWidthFactor(shape: string | undefined, rowIndex: number, rowsCount: number): number {
  const rows = Math.max(1, Number(rowsCount) || 1);
  if (!shape || shape === 'rectangle' || shape === 'square') return 1;
  if (shape === 'corner') return rows > 1 && rowIndex < Math.ceil(rows / 2) ? CORNER_SHORT : 1;

  const progress = rows === 1 ? 1 : rowIndex / (rows - 1);
  const normalized = Math.abs(progress * 2 - 1);

  if (shape === 'semicircle') return CIRCLE_EDGE + (1 - CIRCLE_EDGE) * progress;
  if (shape === 'trapezoid') return TRAPEZOID_TOP + (1 - TRAPEZOID_TOP) * progress;
  if (shape === 'circle') return rows === 1 ? 1 : 1 - (1 - CIRCLE_EDGE) * normalized;
  return 1;
}

export function seatsForRow(
  shape: string | undefined,
  rowIndex: number,
  rowsCount: number,
  maxSeats: number,
): number {
  const seats = Math.max(0, Number(maxSeats) || 0);
  if (!seats || !shape || shape === 'rectangle' || shape === 'square') return seats;

  const factor = rowWidthFactor(shape, rowIndex, rowsCount);
  return Math.max(1, Math.min(seats, Math.round(seats * factor)));
}
