import { BadRequestException, Injectable } from "@nestjs/common";
import { seatingPlanRowModel } from "../schemas/seating-plan-row.schema";
import { seatingPlanSeatModel } from "../schemas/seating-plan-seat.schema";
import {
  NodeKind,
  SEATING_PLAN_ERRORS as ERR,
} from "../constants/seating-plan.constants";
import { expandSector } from "../utils/expand.util";
import { getNode, getRow, assertColor } from "./seating-plan-access";
import { SeatingPlanTotalsService } from "./seating-plan-totals.service";

const SeatingPlanRow = seatingPlanRowModel();
const SeatingPlanSeat = seatingPlanSeatModel();

/** Ряды и места сектора: правки, оверрайды мест и развёрнутая сетка для превью. */
@Injectable()
export class SeatingPlanRowsService {
  constructor(private readonly totals: SeatingPlanTotalsService) {}

  /* ------------------------------------------------------- ряды и места */

  async UpdateRow(dto: any) {
    const { row, plan } = await getRow(dto.id, dto.field);
    assertColor(dto.color);

    const patch: any = {};
    ["label", "seatType", "color", "ticket", "numbering", "geometry"].forEach((key) => {
      if (dto[key] !== undefined) patch[key] = dto[key];
    });
    if (dto.seatsCount !== undefined) patch.seatsCount = Number(dto.seatsCount) || 0;

    await SeatingPlanRow.updateOne({ id: row.id }, { $set: patch });

    // ### Ряд стал короче — оверрайды выпавших мест больше не к чему привязать
    if (patch.seatsCount !== undefined)
      await SeatingPlanSeat.deleteMany({ rowId: row.id, index: { $gte: patch.seatsCount } });

    await this.totals.recalcSector(row.sectorId);
    await this.totals.recalcTotals(plan.id);

    return SeatingPlanRow.findOne({ id: row.id }).lean();
  }

  // ### Применение настройки ко "Всему сектору" из правой панели
  async BulkUpdateRows(dto: any) {
    const { node, plan } = await getNode(dto.sectorId, dto.field);
    const patch: any = {};

    ["label", "seatType", "color", "ticket", "numbering"].forEach((key) => {
      if (dto.patch?.[key] !== undefined) patch[key] = dto.patch[key];
    });
    if (dto.patch?.seatsCount !== undefined) patch.seatsCount = Number(dto.patch.seatsCount) || 0;
    if (!Object.keys(patch).length) throw new BadRequestException(ERR.emptyPatch);

    const result = await SeatingPlanRow.updateMany({ sectorId: node.id }, { $set: patch });

    await this.totals.recalcSector(node.id);
    await this.totals.recalcTotals(plan.id);

    return { updated: result.modifiedCount || 0 };
  }

  // ### Место существует в базе только когда у него есть что переопределять
  async UpdateSeat(dto: any) {
    const { row, plan } = await getRow(dto.rowId, dto.field);
    const index = Number(dto.index);
    if (!Number.isInteger(index) || index < 0 || index >= row.seatsCount)
      throw new BadRequestException(ERR.seatIndexOutOfRange);

    assertColor(dto.color);

    const patch: any = {};
    ["label", "seatType", "color", "ticket", "disabled"].forEach((key) => {
      if (dto[key] !== undefined) patch[key] = dto[key];
    });

    await this.upsertSeatOverride(row, index, patch);

    if (dto.disabled !== undefined) {
      await this.totals.recalcSector(row.sectorId);
      await this.totals.recalcTotals(plan.id);
    }

    return SeatingPlanSeat.findOne({ rowId: row.id, index }).lean();
  }

  async BulkUpdateSeats(dto: any) {
    const { node, plan } = await getNode(dto.sectorId, dto.field);
    const seats = Array.isArray(dto.seats) ? dto.seats : [];
    const rows: any[] = await SeatingPlanRow.find({ sectorId: node.id }).lean();
    const byId = new Map(rows.map((row) => [row.id, row]));

    let updated = 0;
    for (const seat of seats) {
      const row = byId.get(Number(seat.rowId));
      const index = Number(seat.index);
      if (!row || !Number.isInteger(index) || index < 0 || index >= row.seatsCount) continue;

      const patch: any = {};
      ["label", "seatType", "color", "ticket", "disabled"].forEach((key) => {
        if (seat.patch?.[key] !== undefined) patch[key] = seat.patch[key];
      });
      if (Object.keys(patch).length === 1) continue;

      await this.upsertSeatOverride(row, index, patch);
      updated += 1;
    }

    await this.totals.recalcSector(node.id);
    await this.totals.recalcTotals(plan.id);

    return { updated };
  }

  // ### Оверрайд места: правим существующий документ или заводим новый через create.
  // ### updateOne({ upsert }) здесь нельзя: он минует автоинкремент (плагин висит на
  // ### validate), и второе же место получало id: null — дубль уникального ключа.
  private async upsertSeatOverride(row: any, index: number, patch: any) {
    const existing: any = await SeatingPlanSeat.findOne({ rowId: row.id, index }, { id: 1 }).lean();
    if (existing) {
      await SeatingPlanSeat.updateOne({ id: existing.id }, { $set: patch });
      return;
    }
    await SeatingPlanSeat.create({ planId: row.planId, sectorId: row.sectorId, rowId: row.id, index, ...patch });
  }

  // ### Сброс к наследуемому значению — это удаление оверрайда, а не запись пустых полей
  async ResetSeat(dto: any) {
    const { row } = await getRow(dto.rowId, dto.field);
    await SeatingPlanSeat.deleteOne({ rowId: row.id, index: Number(dto.index) });
    await this.totals.recalcSector(row.sectorId);
    return { reset: true };
  }

  /* ------------------------------------------------------ агрегаты и вьюхи */

  // ### Развёрнутая сетка сектора с посчитанными подписями — для превью без материализации
  async ExpandSector(dto: any) {
    const { node } = await getNode(dto.id, dto.field);
    if (node.kind !== NodeKind.SECTOR) throw new BadRequestException(ERR.notASector);

    const [rows, seats]: any[] = await Promise.all([
      SeatingPlanRow.find({ sectorId: node.id }).sort({ index: 1 }).lean(),
      SeatingPlanSeat.find({ sectorId: node.id }).lean(),
    ]);

    return { sector: node, rows: expandSector(node, rows, seats) };
  }
}
