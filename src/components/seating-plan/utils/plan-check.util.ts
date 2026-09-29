import {
  NodeKind,
  SEATING_PLAN_ERRORS as ERR,
  SectorType,
} from "../constants/seating-plan.constants";
import { buildPriceGroups, type PriceGroup } from "./price-groups.util";

/** Места в продаже с ценой 0: сектор (null — «Отдельные места») и тип места. */
export type UnpricedPlaces = {
  sectorId: number | null;
  sectorTitle: string;
  source: string;
  tableNumber: number | null;
  seatsCount: number;
};

/** Что мешает публикации: тело ответа с кодом для фронта, а у цен — где их не хватает. */
export type PlanProblem = {
  statusCode: 400 | 409;
  message: string;
  places?: UnpricedPlaces[];
};

export function groupBy(items: any[], key: string): Map<number, any[]> {
  const map = new Map<number, any[]>();
  items.forEach((item) =>
    map.set(item[key], [...(map.get(item[key]) || []), item]),
  );
  return map;
}

/** Продаваемые группы мест плана по уже загруженным узлам, рядам и местам. */
export function planPriceGroups(
  nodes: any[],
  rows: any[],
  seats: any[],
): PriceGroup[] {
  return buildPriceGroups(
    nodes.filter((node) => node.kind === NodeKind.SECTOR),
    groupBy(rows, "sectorId"),
    groupBy(
      seats.filter((seat) => seat.rowId != null),
      "sectorId",
    ),
    nodes.filter((node) => node.kind === NodeKind.OBJECT),
  ).filter((group) => group.seatsCount > 0);
}

/**
 * Забытая цена — это бесплатный билет, поэтому места в продаже с ценой 0 не публикуются
 * (ни при публикации, ни патчем опубликованной схемы). Снятые с продажи не считаются.
 */
export function unpricedProblem(groups: PriceGroup[]): PlanProblem | null {
  const places = groups
    .filter((group) => group.seatsCount > 0 && !(Number(group.price) > 0))
    .map(({ sectorId, sectorTitle, source, tableNumber, seatsCount }) => ({
      sectorId,
      sectorTitle,
      source,
      tableNumber,
      seatsCount,
    }));
  return places.length
    ? { statusCode: 400, message: ERR.zeroPriceSeats, places }
    : null;
}

/** Проверка схемы перед публикацией: первая мешающая проблема и предупреждения. */
export function checkPlan(
  nodes: any[],
  rows: any[],
  seats: any[],
): { problem: PlanProblem | null; warnings: string[] } {
  const sectors = nodes.filter((node) => node.kind === NodeKind.SECTOR);
  const hasSellableObjects = nodes.some(
    (node) => node.kind === NodeKind.OBJECT && node.isSellable,
  );
  // Продавать можно и без секторов: банкетный зал из одних номерных столов — тоже схема.
  if (!sectors.length && !hasSellableObjects) {
    return {
      problem: { statusCode: 400, message: ERR.planHasNoSectors },
      warnings: [],
    };
  }

  const groups = planPriceGroups(nodes, rows, seats);
  if (!groups.length)
    return {
      problem: { statusCode: 400, message: ERR.planHasNoSellableSeats },
      warnings: [],
    };

  for (const sector of sectors) {
    const labels = new Set<string>();
    for (const row of rows.filter((item) => item.sectorId === sector.id)) {
      if (labels.has(row.label)) {
        return {
          problem: {
            statusCode: 409,
            message: `${ERR.duplicateRowLabel}:${sector.id}:${row.label}`,
          },
          warnings: [],
        };
      }
      labels.add(row.label);
    }
  }

  const unpriced = unpricedProblem(groups);
  if (unpriced) return { problem: unpriced, warnings: [] };

  const warnings: string[] = [];
  sectors
    .filter(
      (sector) =>
        sector.sectorType === SectorType.STANDING && !Number(sector.capacity),
    )
    .forEach((sector) =>
      warnings.push(`sector ${sector.id}: standing sector without capacity`),
    );

  // Мультивыбор категорий в макете есть, правила распределения мест — нет:
  // публикуем по первой категории и говорим об этом явно.
  nodes
    .filter(
      (node) =>
        Array.isArray(node.ticket?.categories) &&
        node.ticket.categories.length > 1,
    )
    .forEach((node) =>
      warnings.push(
        `sector ${node.id}: only the first of ${node.ticket.categories.length} categories is used`,
      ),
    );

  return { problem: null, warnings };
}
