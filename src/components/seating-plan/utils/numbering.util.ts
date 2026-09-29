import {
  RowDirection,
  SeatDirection,
} from "../constants/seating-plan.constants";

export type NumberingRule = {
  start?: number;
  step?: number;
  direction?: string;
};

export type Numbering = {
  row?: NumberingRule;
  seat?: NumberingRule;
};

export const DEFAULT_NUMBERING: Numbering = {
  row: { start: 1, step: 1, direction: RowDirection.TOP_DOWN },
  seat: { start: 1, step: 1, direction: SeatDirection.LEFT_TO_RIGHT },
};

// ### Шаг 0 или отрицательный превратил бы всю нумерацию в один и тот же номер
const normalize = (rule: NumberingRule | undefined, fallback: NumberingRule) => {
  const start = Number(rule?.start);
  const step = Number(rule?.step);

  return {
    start: Number.isFinite(start) ? start : (fallback.start as number),
    step: Number.isFinite(step) && step > 0 ? step : (fallback.step as number),
    direction: rule?.direction || fallback.direction,
  };
};

// ### Номера идут от start с шагом step, а direction только переворачивает их порядок:
// ### при bottom_up первый сверху ряд получает последний номер, а не отрицательный.
const buildNumbers = (count: number, rule: NumberingRule, fallback: NumberingRule, reversedDirection: string) => {
  const { start, step, direction } = normalize(rule, fallback);
  const total = Math.max(0, Math.trunc(Number(count) || 0));

  const numbers = Array.from({ length: total }, (_, i) => start + i * step);

  return direction === reversedDirection ? numbers.reverse() : numbers;
};

export function buildRowNumbers(rowsCount: number, numbering?: Numbering): number[] {
  return buildNumbers(
    rowsCount,
    numbering?.row ?? {},
    DEFAULT_NUMBERING.row as NumberingRule,
    RowDirection.BOTTOM_UP,
  );
}

export function buildSeatNumbers(seatsCount: number, numbering?: Numbering): number[] {
  return buildNumbers(
    seatsCount,
    numbering?.seat ?? {},
    DEFAULT_NUMBERING.seat as NumberingRule,
    SeatDirection.RIGHT_TO_LEFT,
  );
}

// ### Подписи из макета: ряд "Row 1", место "Row 1 - Seat#9"
export function buildRowLabels(rowsCount: number, numbering?: Numbering): string[] {
  return buildRowNumbers(rowsCount, numbering).map((number) => `Row ${number}`);
}

export function buildSeatLabels(
  rowLabel: string,
  seatsCount: number,
  numbering?: Numbering,
): string[] {
  return buildSeatNumbers(seatsCount, numbering).map(
    (number) => `${rowLabel} - Seat#${number}`,
  );
}
