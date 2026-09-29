import { isStandingSector } from './object-places.util';

type ProjectedZone = { sectorId: number | null; standing: boolean; eventSectorId: string; eventZoneId: string };

/**
 * Зона события каждого стоячего сектора схемы: витрина продаёт его количеством и должна
 * знать зону, а не угадывать её id. Сектор без зоны (вместимость 0, снят с продажи) — null.
 */
export function standingZoneLinks(nodes: any[], groups: ProjectedZone[]) {
  const byNode = new Map(groups.filter((group) => group.standing).map((group) => [group.sectorId, group]));
  return nodes.filter(isStandingSector).map((node) => {
    const group = byNode.get(node.id);
    return { id: node.id as number, eventSectorId: group?.eventSectorId ?? null, eventZoneId: group?.eventZoneId ?? null };
  });
}
