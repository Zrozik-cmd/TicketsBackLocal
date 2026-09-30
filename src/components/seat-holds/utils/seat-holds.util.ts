import { SEAT_HOLD_ERRORS as ERR } from "../constants/seat-holds.constants";

/** Строка заказа, как её прислал покупатель: зона, количество и (по схеме) места. */
export type OrderLineSeatsInput = {
  zoneId: string;
  count: number;
  session?: number;
  seatIds?: number[];
};

/** Место схемы, нужное для проверки. */
export type SeatForCheck = {
  id: number;
  label: string | null;
  eventZoneId: string | null;
  saleStatus: string;
};

/** Места строки заказа — в строку и в билеты: id места схемы и его подпись. */
export type LineSeats = {
  zoneId: string;
  seats: { id: number; label: string }[];
};

/**
 * Проверка мест в строках заказа (места уже загружены из схемы события). Чистая функция:
 * первая ошибка — код для фронта, иначе места по строкам. Строки без мест — без проверки:
 * их билеты без места, как раньше.
 */
export function checkOrderSeats(
  lines: OrderLineSeatsInput[],
  seatsById: Map<number, SeatForCheck>,
): { error: string | null; lines: LineSeats[] } {
  const seen = new Set<number>();
  const out: LineSeats[] = [];
  for (const line of lines) {
    const ids = line.seatIds ?? [];
    if (!ids.length) continue;
    if (typeof line.session === "number")
      return { error: ERR.seatsForSessions, lines: [] };
    if (ids.length !== line.count)
      return { error: ERR.seatsCountMismatch, lines: [] };
    const seats: LineSeats["seats"] = [];
    for (const id of ids) {
      if (seen.has(id)) return { error: ERR.seatDuplicated, lines: [] };
      seen.add(id);
      const seat = seatsById.get(id);
      if (
        !seat ||
        seat.eventZoneId !== line.zoneId ||
        seat.saleStatus === "BLOCKED"
      ) {
        return { error: ERR.seatNotInZone, lines: [] };
      }
      seats.push({ id: seat.id, label: seat.label ?? "" });
    }
    out.push({ zoneId: line.zoneId, seats });
  }
  return { error: null, lines: out };
}

/** Места, уже записанные в строки заказа, — для повторного захвата (продление брони). */
export function lineSeatsOf(
  lines: { zoneId: string; seats?: { id: number; label: string }[] }[],
): LineSeats[] {
  return lines
    .filter((line) => line.seats?.length)
    .map((line) => ({ zoneId: line.zoneId, seats: line.seats! }));
}

/** Места — в строки заказа того же порядка: строке своей зоны её места. */
export function attachSeatsToLines<T extends { zoneId: string }>(
  lines: T[],
  seats: LineSeats[] | null,
): T[] {
  if (!seats?.length) return lines;
  const byZone = new Map(seats.map((line) => [line.zoneId, line.seats]));
  return lines.map((line) =>
    byZone.has(line.zoneId)
      ? { ...line, seats: byZone.get(line.zoneId) }
      : line,
  );
}

type LinePlacement = {
  session?: number;
  sessionDate?: string;
  sessionStart?: string;
  sessionEnd?: string;
  seats?: { id: number; label: string }[];
};

/**
 * Где сидит i-й билет строки: сеанс регулярного события и место схемы. Поля строки
 * заказа переносятся на билет, чтобы напечатанный билет показывал то, что купили.
 */
export function ticketPlacementFields(
  line: LinePlacement,
  index: number,
): Record<string, unknown> {
  const seat = line.seats?.[index];
  return {
    ...(typeof line.session === "number"
      ? {
          session: line.session,
          sessionDate: line.sessionDate,
          sessionStart: line.sessionStart,
          sessionEnd: line.sessionEnd,
        }
      : {}),
    ...(seat ? { seatId: seat.id, seatLabel: seat.label } : {}),
  };
}

const SEAT_TEXT: Record<string, (row: string, seat: string) => string> = {
  en: (row, seat) => `Row ${row}, seat ${seat}`,
  ru: (row, seat) => `Ряд ${row}, место ${seat}`,
  th: (row, seat) => `แถว ${row} ที่นั่ง ${seat}`,
};
const PLACE_WORD: Record<string, string> = {
  en: "seat",
  ru: "место",
  th: "ที่นั่ง",
};

// Мебель схемы в подписи места: «Table 5» → «Стол 5», «Sofa #12» → «Диван #12»
const OBJECT_WORD: Record<string, Record<string, string>> = {
  en: { Table: "Table", Chair: "Chair", Sofa: "Sofa", "Accessible seat": "Accessible seat" },
  ru: { Table: "Стол", Chair: "Стул", Sofa: "Диван", "Accessible seat": "Место для МГН" },
  th: { Table: "โต๊ะ", Chair: "เก้าอี้", Sofa: "โซฟา", "Accessible seat": "ที่นั่งสำหรับผู้พิการ" },
};

/** Подпись места схемы («Row 1 - Seat#9», «Sofa #21 - Seat#2») на языке билета. */
export function seatLabelText(
  label: string | null | undefined,
  locale: string,
): string {
  const text = String(label ?? "").trim();
  const lang = SEAT_TEXT[locale] ? locale : "en";
  const row = /^Row\s+(.+?)\s*-\s*Seat#(.+)$/.exec(text);
  if (row) return SEAT_TEXT[lang](row[1], row[2]);
  return text
    .replace(
      /^(Table|Chair|Sofa|Accessible seat)(?=\s|$)/,
      (word: string) => OBJECT_WORD[lang][word] ?? word,
    )
    .replace(
      /\s*-\s*Seat#(\S+)$/,
      (_, n: string) => `, ${PLACE_WORD[lang]} ${n}`,
    );
}
