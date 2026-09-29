import { buildSeatLabels, Numbering } from "./numbering.util";
import { SELLABLE_OBJECTS, SectorType } from "../constants/seating-plan.constants";
import { objectPlaces } from "./object-places.util";

export type TicketSettings = {
  priceMode?: string;
  price?: number;
  tariffLevel?: number;
  categories?: string[];
  availability?: string;
};

// ### Настройка наследуется сектор -> ряд -> место, значение хранится только там, где задано
// ### явно. Поэтому правка цены сектора не затирает ручные переопределения ряда и места.
export function resolveTicket(
  sector: any,
  row?: any,
  seat?: any,
): TicketSettings {
  return {
    ...ownTicket(sector),
    ...ownTicket(row),
    ...ownTicket(seat),
  };
}

// ### Только явно заданные поля уровня: пустая строка, null и пустой список категорий
// ### значат «бери выше», а не «цена 0» — иначе пустое поле ряда обнуляло бы цену сектора
function ownTicket(level: any): TicketSettings {
  const ticket = level?.ticket;
  if (!ticket || typeof ticket !== "object") return {};
  const own: TicketSettings = {};
  Object.entries(ticket).forEach(([key, value]) => {
    if (value === null || value === undefined || value === "") return;
    if (Array.isArray(value) && !value.length) return;
    (own as any)[key] = key === "price" ? Number(value) || 0 : value;
  });
  return own;
}

export function resolveField(sector: any, row: any, seat: any, field: string) {
  if (seat && seat[field] !== null && seat[field] !== undefined) return seat[field];
  if (row && row[field] !== null && row[field] !== undefined) return row[field];
  return sector ? sector[field] : null;
}

export type ExpandedSeat = {
  rowId: number;
  index: number;
  label: string;
  seatType: any;
  color: any;
  ticket: TicketSettings;
  disabled: boolean;
  // ### Есть ли под местом сохранённый документ-оверрайд
  overridden: boolean;
};

export type ExpandedRow = {
  id: number;
  index: number;
  label: string;
  seatsCount: number;
  seats: ExpandedSeat[];
};

// ### Полная сетка сектора из rowsCount x seatsPerRow и спарс-оверрайдов.
// ### Материализовать места в черновике незачем: шаблон на 50 000 мест весит
// ### десятки документов, а не 50 000.
export function expandSector(
  sector: any,
  rows: any[],
  seats: any[] = [],
): ExpandedRow[] {
  if (!sector || sector.sectorType === SectorType.STANDING) return [];

  const seatsByRow = new Map<number, Map<number, any>>();
  seats.forEach((seat) => {
    const bucket = seatsByRow.get(seat.rowId) || new Map();
    bucket.set(seat.index, seat);
    seatsByRow.set(seat.rowId, bucket);
  });

  return [...rows]
    .sort((a, b) => a.index - b.index)
    .map((row) => {
      const numbering: Numbering = row.numbering || sector.numbering || {};
      const labels = buildSeatLabels(row.label, row.seatsCount, numbering);
      const overrides = seatsByRow.get(row.id) || new Map();

      const seatsView = labels.map((label, index) => {
        const override = overrides.get(index);
        return {
          rowId: row.id,
          index,
          label: override?.label || label,
          seatType: resolveField(sector, row, override, "seatType"),
          color: resolveField(sector, row, override, "color"),
          ticket: resolveTicket(sector, row, override),
          disabled: Boolean(override?.disabled),
          overridden: Boolean(override),
        };
      });

      return {
        id: row.id,
        index: row.index,
        label: row.label,
        seatsCount: row.seatsCount,
        seats: seatsView,
      };
    });
}

// ### Места сектора: ряды плюс вложенные продаваемые объекты (стол, стул, диван, места для МГН)
export function sectorSeatsTotal(
  sector: any,
  rows: any[],
  children: any[] = [],
  seats: any[] = [],
): number {
  const nested = children
    .filter((node) => SELLABLE_OBJECTS.includes(node.objectType))
    .reduce((sum, node) => sum + objectPlaces(node), 0);

  if (sector.sectorType === SectorType.STANDING) {
    return (Number(sector.capacity) || 0) + nested;
  }

  const disabled = new Set(
    seats.filter((seat) => seat.disabled).map((seat) => `${seat.rowId}:${seat.index}`),
  );

  const inRows = rows.reduce((sum, row) => {
    const count = Number(row.seatsCount) || 0;
    const holes = [...disabled].filter((key) => key.startsWith(`${row.id}:`)).length;
    return sum + Math.max(0, count - holes);
  }, 0);

  return inRows + nested;
}
