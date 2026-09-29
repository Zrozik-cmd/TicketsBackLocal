import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { seatingPlanModel } from "../schemas/seating-plan.schema";
import { seatingPlanNodeModel } from "../schemas/seating-plan-node.schema";
import { seatingPlanRowModel } from "../schemas/seating-plan-row.schema";
import {
  SeatingPlanStatus,
  SECTOR_COLOR_IDS,
  VenueType,
  SEATING_PLAN_ERRORS as ERR,
} from "../constants/seating-plan.constants";

/** Ownership: план принадлежит организатору (у менеджера — создавшему его организатору). */
export type Field = { creator: number };

const SeatingPlan = seatingPlanModel();
const SeatingPlanNode = seatingPlanNodeModel();
const SeatingPlanRow = seatingPlanRowModel();

/**
 * Доступ к плану и его узлам для всех сервисов конструктора: ownership проверяется
 * через план, правка опубликованного и архивного плана запрещена.
 */
export async function getPlan(id: any, field: Field): Promise<any> {
  const plan: any = await SeatingPlan.findOne({ id: Number(id), ...field }).lean();
  if (!plan) throw new NotFoundException(ERR.planNotFound);
  return plan;
}

export async function getEditablePlan(id: any, field: Field): Promise<any> {
  const plan: any = await getPlan(id, field);
  if (plan.status === SeatingPlanStatus.PUBLISHED)
    throw new ConflictException(ERR.planIsPublished);
  if (plan.status === SeatingPlanStatus.ARCHIVED)
    throw new ConflictException(ERR.planIsArchived);
  return plan;
}

export async function getNode(id: any, field: Field) {
  const node: any = await SeatingPlanNode.findOne({ id: Number(id) }).lean();
  if (!node) throw new NotFoundException(ERR.nodeNotFound);
  const plan = await getEditablePlan(node.planId, field);
  return { node, plan };
}

export async function getRow(id: any, field: Field) {
  const row: any = await SeatingPlanRow.findOne({ id: Number(id) }).lean();
  if (!row) throw new NotFoundException(ERR.rowNotFound);
  const plan = await getEditablePlan(row.planId, field);
  return { row, plan };
}

export function assertColor(color?: string) {
  if (color && !SECTOR_COLOR_IDS.includes(color))
    throw new BadRequestException(ERR.unknownColor);
}

// ### Различие макетов Setting Playground и Vanue not sport: у спортивной площадки
// ### выбирается объект, у остальных сцен — форма.
export function assertVenue(patch: any) {
  if (patch.playgroundType && patch.venueType && patch.venueType !== VenueType.PLAYGROUND)
    throw new BadRequestException(ERR.playgroundTypeRequiresPlayground);
  if (patch.venueType === VenueType.PLAYGROUND && patch.form)
    throw new BadRequestException(ERR.formNotAllowedForPlayground);
}
