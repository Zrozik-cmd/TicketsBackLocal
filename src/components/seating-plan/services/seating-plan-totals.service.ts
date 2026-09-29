import { Injectable } from "@nestjs/common";
import { seatingPlanModel } from "../schemas/seating-plan.schema";
import { seatingPlanRoomModel } from "../schemas/seating-plan-room.schema";
import { seatingPlanNodeModel } from "../schemas/seating-plan-node.schema";
import { seatingPlanRowModel } from "../schemas/seating-plan-row.schema";
import { seatingPlanSeatModel } from "../schemas/seating-plan-seat.schema";
import {
  NodeKind,
} from "../constants/seating-plan.constants";
import { resolveTicket, sectorSeatsTotal } from "../utils/expand.util";
import { objectPlaces, primaryCategory, resolveObjectTicket } from "../utils/price-groups.util";
import { isSellableObject } from "../utils/object-places.util";
import { addSectorSeatCounts, emptySeatCounts } from "../utils/seat-counts.util";
import { getPlan } from "./seating-plan-access";

const SeatingPlan = seatingPlanModel();
const SeatingPlanRoom = seatingPlanRoomModel();
const SeatingPlanNode = seatingPlanNodeModel();
const SeatingPlanRow = seatingPlanRowModel();
const SeatingPlanSeat = seatingPlanSeatModel();

/** Итоги конструктора: Live Review, число мест сектора и денормализованные totals плана. */
@Injectable()
export class SeatingPlanTotalsService {
  // ### Live Review: по всему проекту либо по одному выбранному сектору
  async Summary(dto: any) {
    const plan = await getPlan(dto.id, dto.field);

    const [nodes, rows, seats]: any[] = await Promise.all([
      SeatingPlanNode.find({ planId: plan.id }).lean(),
      SeatingPlanRow.find({ planId: plan.id }).lean(),
      SeatingPlanSeat.find({ planId: plan.id }).lean(),
    ]);

    const wanted = dto.nodeId ? Number(dto.nodeId) : null;
    const sectors = nodes
      .filter((node) => node.kind === NodeKind.SECTOR)
      .filter((node) => (wanted ? node.id === wanted : true))
      .map((sector) => {
        const sectorRows = rows.filter((row) => row.sectorId === sector.id);
        const sectorSeats = seats.filter((seat) => seat.sectorId === sector.id);
        const children = nodes.filter((node) => node.parentId === sector.id);
        const { byCategory, bySeatType } = addSectorSeatCounts(emptySeatCounts(), sector, sectorRows, sectorSeats);

        // ### Стулья, диваны и столы внутри сектора — со своим классом или классом сектора
        children
          .filter(isSellableObject)
          .forEach((object) => {
            const ticket = resolveObjectTicket(object, sector);
            if (ticket.availability === "unavailable") return;
            const category = primaryCategory(ticket);
            byCategory[category] = (byCategory[category] || 0) + objectPlaces(object);
          });

        return {
          id: sector.id,
          title: sector.title,
          color: sector.color,
          sectorType: sector.sectorType,
          seats: sectorSeatsTotal(sector, sectorRows, children, sectorSeats),
          ticket: resolveTicket(sector),
          byCategory,
          bySeatType,
          photo: sector.photo || null,
        };
      });

    return {
      scope: wanted ? "SECTOR" : "PROJECT",
      title: plan.title,
      sectorTotal: sectors.length,
      totalSeats: sectors.reduce((sum, sector) => sum + sector.seats, 0),
      sectors,
    };
  }

  touch(planId: number) {
    return SeatingPlan.updateOne({ id: planId }, { $set: { updatedAt: new Date() } });
  }

  async recalcSector(sectorId: number) {
    const sector: any = await SeatingPlanNode.findOne({ id: sectorId }).lean();
    if (!sector || sector.kind !== NodeKind.SECTOR) return;

    const [rows, seats, children]: any[] = await Promise.all([
      SeatingPlanRow.find({ sectorId }).lean(),
      SeatingPlanSeat.find({ sectorId }).lean(),
      SeatingPlanNode.find({ parentId: sectorId }).lean(),
    ]);

    const seatsTotal = sectorSeatsTotal(sector, rows, children, seats);
    await SeatingPlanNode.updateOne({ id: sectorId }, { $set: { seatsTotal } });
    return seatsTotal;
  }

  // ### Денормализованные итоги проекта: Live Review читает их одним документом
  async recalcTotals(planId: number, persist = false) {
    const [rooms, nodes, rows, seats]: any[] = await Promise.all([
      SeatingPlanRoom.countDocuments({ planId }),
      SeatingPlanNode.find({ planId }).lean(),
      SeatingPlanRow.find({ planId }).lean(),
      SeatingPlanSeat.find({ planId }).lean(),
    ]);

    const counts = emptySeatCounts();
    const { byCategory, bySeatType } = counts;
    const pending: { id: number; seatsTotal: number }[] = [];
    let seatsTotal = 0;
    let sectors = 0;

    nodes
      .filter((node) => node.kind === NodeKind.SECTOR)
      .forEach((sector) => {
        sectors += 1;
        const sectorRows = rows.filter((row) => row.sectorId === sector.id);
        const sectorSeats = seats.filter((seat) => seat.sectorId === sector.id);
        const children = nodes.filter((node) => node.parentId === sector.id);

        // ### Считаем сектор здесь же и сразу освежаем его денормализованное число мест:
        // ### объект, попавший внутрь границ, менял итоги проекта, но не шапку сектора.
        const own = sectorSeatsTotal(sector, sectorRows, children, sectorSeats);
        seatsTotal += own;
        if (sector.seatsTotal !== own) pending.push({ id: sector.id, seatsTotal: own });

        addSectorSeatCounts(counts, sector, sectorRows, sectorSeats);
      });

    // ### Стулья, диваны и столы: класс — свой или сектора, в котором стоят. Места объектов
    // ### внутри секторов уже вошли в seatsTotal сектора, вне секторов — добавляем здесь.
    const sectorsById = new Map(nodes.filter((node) => node.kind === NodeKind.SECTOR).map((node) => [node.id, node]));
    nodes
      .filter(isSellableObject)
      .forEach((object) => {
        const parent = object.parentId != null ? sectorsById.get(object.parentId) : null;
        const ticket = resolveObjectTicket(object, parent);
        const places = objectPlaces(object);
        if (!parent) seatsTotal += places;
        if (ticket.availability === "unavailable") return;
        const category = primaryCategory(ticket);
        byCategory[category] = (byCategory[category] || 0) + places;
      });

    for (const item of pending)
      await SeatingPlanNode.updateOne({ id: item.id }, { $set: { seatsTotal: item.seatsTotal } });

    const totals = { rooms, sectors, seats: seatsTotal, byCategory, bySeatType };

    if (persist) await SeatingPlan.updateOne({ id: planId }, { $set: { totals } });

    return totals;
  }
}
