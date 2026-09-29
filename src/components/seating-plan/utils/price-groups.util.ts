import { Availability, ObjectType, SELLABLE_OBJECTS, SectorType, TicketCategory } from '../constants/seating-plan.constants';
import { expandSector, ExpandedSeat, resolveTicket } from './expand.util';
import { objectPlaces } from './object-places.util';

export type PlanSeatDraft = {
  /** Сектор, в котором стоит место (у объекта вне секторов — null). */
  sectorId: number | null;
  /** Ряд — у места в ряду; у объекта (стул, диван, стол) — null. */
  rowId: number | null;
  /** Объект, который даёт место (стул, диван, стол); у места в ряду — null. */
  objectId: number | null;
  index: number;
  label: string;
  seatType: any;
  color: any;
  sellable: boolean;
};

export type PriceGroup = {
  key: string;
  /** Сектор-владелец; у объектов вне секторов — null (они продаются отдельным сектором). */
  sectorId: number | null;
  sectorTitle: string;
  sectorColor: string | null;
  /** `rows` — места рядов (и стоячий сектор), иначе тип объекта: add_chair, add_sofa… */
  source: string;
  /** Номерной стол продаётся своей зоной: это его id и номер. */
  objectId: number | null;
  tableNumber: number | null;
  category: string;
  price: number;
  seatsCount: number;
  seats: PlanSeatDraft[];
  /** Стоячий сектор мест не даёт: продаётся количеством, как тариф без схемы. */
  standing: boolean;
};

export const ROWS_SOURCE = 'rows';

/**
 * Категория пока одна на место: в макете чекбоксы с мультивыбором, но правило, какое
 * место в какую из выбранных категорий попадает, не зафиксировано. Берём первую и не
 * молчим об этом — см. warnings в publish.
 */
export const primaryCategory = (ticket: any): string => {
  const categories = ticket?.categories;
  if (Array.isArray(categories) && categories.length) return categories[0];
  if (typeof categories === 'string' && categories) return categories;
  return TicketCategory.ECONOMY;
};

export const groupKey = (sectorId: number | null, source: string, category: string, price: number) =>
  `${sectorId ?? 'free'}|${source}|${category}|${price}`;

const sellable = (seat: ExpandedSeat) => !seat.disabled && seat.ticket?.availability !== Availability.UNAVAILABLE;

export { objectPlaces } from './object-places.util';

/**
 * Билет объекта: своя цена/класс/доступность, а чего не задано — берётся с сектора,
 * внутри которого объект стоит. У объекта вне секторов — только своё.
 */
export function resolveObjectTicket(object: any, parent?: any) {
  return resolveTicket(parent ?? null, null, object);
}

/**
 * Продаваемые места группируются по сектору, источнику (ряды или тип объекта), классу
 * и цене — одна группа становится одной зоной события, через которую идёт продажа.
 * Номерной стол всегда отдельная зона: покупатель выбирает конкретный стол.
 */
export function buildPriceGroups(
  sectors: any[],
  rowsBySector: Map<number, any[]>,
  seatsBySector: Map<number, any[]>,
  objects: any[] = [],
): PriceGroup[] {
  const groups = new Map<string, PriceGroup>();

  const push = (
    sector: any | null,
    source: string,
    category: string,
    price: number,
    seat: PlanSeatDraft | null,
    options: { standing?: boolean; count?: number; object?: any } = {},
  ) => {
    const table = options.object?.objectType === ObjectType.NUMBERED_TABLE ? options.object : null;
    const key = table
      ? `${sector?.id ?? 'free'}|table:${table.id}`
      : groupKey(sector?.id ?? null, source, category, price);
    const group: PriceGroup = groups.get(key) || {
      key,
      sectorId: sector?.id ?? null,
      sectorTitle: sector?.title || '',
      sectorColor: sector?.color ?? null,
      source,
      objectId: table?.id ?? null,
      tableNumber: table ? Number(table.tableNumber) || null : null,
      category,
      price,
      seatsCount: 0,
      seats: [] as PlanSeatDraft[],
      standing: Boolean(options.standing),
    };

    group.seatsCount += options.count ?? 1;
    if (seat) group.seats.push(seat);
    groups.set(key, group);
  };

  sectors.forEach((sector) => {
    if (sector.sectorType === SectorType.STANDING) {
      const ticket = resolveTicket(sector);
      const capacity = Number(sector.capacity) || 0;
      if (capacity > 0 && ticket.availability !== Availability.UNAVAILABLE)
        push(sector, ROWS_SOURCE, primaryCategory(ticket), Number(ticket.price) || 0, null, {
          standing: true,
          count: capacity,
        });
      return;
    }

    const rows = rowsBySector.get(sector.id) || [];
    const seats = seatsBySector.get(sector.id) || [];

    expandSector(sector, rows, seats).forEach((row) =>
      row.seats.forEach((seat) => {
        if (!sellable(seat)) return;

        push(sector, ROWS_SOURCE, primaryCategory(seat.ticket), Number(seat.ticket.price) || 0, {
          sectorId: sector.id,
          rowId: seat.rowId,
          objectId: null,
          index: seat.index,
          label: seat.label,
          seatType: seat.seatType,
          color: seat.color,
          sellable: true,
        });
      }),
    );
  });

  // Стулья, диваны, столы и номерные столы: у каждого своя цена или цена сектора,
  // в котором он стоит. Объект вне секторов продаётся отдельным сектором события.
  const sectorsById = new Map(sectors.map((sector) => [sector.id, sector]));
  objects
    .filter((node) => SELLABLE_OBJECTS.includes(node.objectType))
    .forEach((object) => {
      const parent = object.parentId != null ? (sectorsById.get(object.parentId) ?? null) : null;
      const ticket = resolveObjectTicket(object, parent);
      if (ticket.availability === Availability.UNAVAILABLE) return;

      const category = primaryCategory(ticket);
      const price = Number(ticket.price) || 0;
      const places = objectPlaces(object);
      const base = objectLabel(object);

      for (let index = 0; index < places; index++) {
        push(
          parent,
          object.objectType,
          category,
          price,
          {
            sectorId: parent?.id ?? null,
            rowId: null,
            objectId: object.id,
            index,
            label: places > 1 ? `${base} - Seat#${index + 1}` : base,
            seatType: object.objectType === ObjectType.ADD_SOFA ? 'sofa' : 'chair',
            color: object.color ?? null,
            sellable: true,
          },
          { object },
        );
      }
    });

  return [...groups.values()];
}

/** Подпись места объекта в билете: «Table 3», «Sofa #12». */
export function objectLabel(object: any): string {
  if (object.objectType === ObjectType.NUMBERED_TABLE) return `Table ${object.tableNumber ?? object.id}`;
  const names: Record<string, string> = {
    [ObjectType.ADD_TABLE]: 'Table',
    [ObjectType.ADD_CHAIR]: 'Chair',
    [ObjectType.ADD_SOFA]: 'Sofa',
    [ObjectType.DISABLED_SEATS]: 'Accessible seat',
  };
  return `${names[object.objectType] ?? 'Seat'} #${object.id}`;
}
