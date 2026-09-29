import { NodeKind } from './constants/seating-plan.constants';
import { seatingPlanNodeModel } from './schemas/seating-plan-node.schema';
import { standingZoneLinks } from './utils/standing-zones.util';

/**
 * Записывает на стоячие секторы опубликованного снапшота их зону события. Вызывается
 * публикацией и мягким патчем после пересборки зон; повтор безопасен — пишет то же самое.
 */
export async function linkStandingZones(planId: number, groups: Parameters<typeof standingZoneLinks>[1]) {
  const Node = seatingPlanNodeModel();
  const nodes = await Node.find({ planId, kind: NodeKind.SECTOR }).select({ id: 1, kind: 1, sectorType: 1 }).lean();
  const links = standingZoneLinks(nodes, groups);
  if (!links.length) return;
  await Node.bulkWrite(
    links.map(({ id, eventSectorId, eventZoneId }) => ({
      updateOne: { filter: { id, planId }, update: { $set: { eventSectorId, eventZoneId } } },
    })),
  );
}
