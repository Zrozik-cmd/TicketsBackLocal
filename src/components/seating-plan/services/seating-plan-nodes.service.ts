import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import mongoose from "mongoose";
import { seatingPlanRoomModel } from "../schemas/seating-plan-room.schema";
import { seatingPlanNodeModel } from "../schemas/seating-plan-node.schema";
import { seatingPlanRowModel } from "../schemas/seating-plan-row.schema";
import { seatingPlanSeatModel } from "../schemas/seating-plan-seat.schema";
import { IMedia, MediaSchema } from "../../media/schemas/media.schema";
import { MediaService } from "../../media/media.service";
import {
  NodeKind,
  SEATING_PLAN_ERRORS as ERR,
} from "../constants/seating-plan.constants";
import { buildRowLabels } from "../utils/numbering.util";
import { centerInside, normalizeGeometry } from "../utils/geometry.util";
import { seatsForRow } from "../utils/row-shape.util";
import { isSellableObject, isStandingSector } from "../utils/object-places.util";
import { labelFields, stripMeta } from "../utils/node-fields.util";
import { getEditablePlan, getNode, assertColor, assertVenue } from "./seating-plan-access";
import { SeatingPlanTotalsService } from "./seating-plan-totals.service";

const SeatingPlanRoom = seatingPlanRoomModel();
const SeatingPlanNode = seatingPlanNodeModel();
const SeatingPlanRow = seatingPlanRowModel();
const SeatingPlanSeat = seatingPlanSeatModel();

/** Узлы холста: секторы, площадки и объекты, их ряды и вложенность объектов в секторы. */
@Injectable()
export class SeatingPlanNodesService {
  constructor(
    private readonly mediaService: MediaService,
    private readonly totals: SeatingPlanTotalsService,
  ) {}

  private get mediaModel(): mongoose.Model<IMedia> {
    return (mongoose.models.Media as mongoose.Model<IMedia>) ?? mongoose.model<IMedia>("Media", MediaSchema);
  }

  /* ----------------------------------------------------------------- узлы */

  async CreateNode(dto: any) {
    const plan = await getEditablePlan(dto.planId, dto.field);
    const room: any = await SeatingPlanRoom.findOne({ id: Number(dto.roomId), planId: plan.id }).lean();
    if (!room) throw new NotFoundException(ERR.roomNotFound);

    assertColor(dto.color);
    assertVenue(dto);

    const geometry = normalizeGeometry(dto.geometry || {});

    const node: any = await SeatingPlanNode.create({
      planId: plan.id,
      roomId: room.id,
      kind: dto.kind,
      title: dto.title || "",
      geometry,
      color: dto.color || null,
      venueType: dto.venueType,
      playgroundType: dto.playgroundType,
      form: dto.form,
      sectorType: dto.sectorType,
      rowsCount: Number(dto.rowsCount) || 0,
      seatsPerRow: Number(dto.seatsPerRow) || 0,
      capacity: Number(dto.capacity) || 0,
      seatType: dto.seatType,
      numbering: dto.numbering || {},
      ticket: dto.ticket || {},
      objectType: dto.objectType,
      decor: dto.decor === true,
      soldWhole: dto.soldWhole === true,
      isSellable: isSellableObject(dto),
      tableNumber: dto.tableNumber ?? null,
      ...labelFields(dto),
    });

    // ### Add Sector сразу создаёт ряды: конструктор рисует их без второго запроса
    if (node.kind === NodeKind.SECTOR) await this.syncRows(node);
    if (node.kind === NodeKind.OBJECT) await this.attachToSector(node);

    await this.totals.recalcTotals(plan.id, true);
    return SeatingPlanNode.findOne({ id: node.id }).lean();
  }

  async UpdateNode(dto: any) {
    const { node, plan } = await getNode(dto.id, dto.field);

    assertColor(dto.color);
    assertVenue({ venueType: dto.venueType ?? node.venueType, playgroundType: dto.playgroundType, form: dto.form });

    const patch: any = {};
    const direct = [
      "title", "color", "locked", "venueType", "playgroundType", "form",
      "sectorType", "seatType", "numbering", "ticket", "objectType", "tableNumber", "decor",
      "text", "fontSize", "labelStyle", "soldWhole",
    ];
    direct.forEach((key) => {
      if (dto[key] !== undefined) patch[key] = dto[key];
    });

    if (dto.geometry !== undefined) patch.geometry = normalizeGeometry(dto.geometry);
    if (dto.rowsCount !== undefined) patch.rowsCount = Number(dto.rowsCount) || 0;
    if (dto.seatsPerRow !== undefined) patch.seatsPerRow = Number(dto.seatsPerRow) || 0;
    if (dto.capacity !== undefined) patch.capacity = Number(dto.capacity) || 0;
    if (dto.objectType !== undefined || dto.decor !== undefined) patch.isSellable = isSellableObject({ ...node, ...patch });

    await SeatingPlanNode.updateOne({ id: node.id }, { $set: patch });
    const updated: any = await SeatingPlanNode.findOne({ id: node.id }).lean();

    // ### Ряды перегенерируются с сохранением оверрайдов по index — ключу идентичности
    const gridChanged =
      dto.rowsCount !== undefined ||
      dto.seatsPerRow !== undefined ||
      dto.numbering !== undefined ||
      dto.form !== undefined || dto.sectorType !== undefined;
    if (updated.kind === NodeKind.SECTOR && gridChanged) await this.syncRows(updated);

    // ### Сдвинули объект — заново решаем, в каком он секторе; сдвинули сектор —
    // ### пересчитываем всё, что могло в него попасть или выпасть
    if (dto.geometry !== undefined) {
      if (updated.kind === NodeKind.OBJECT) await this.attachToSector(updated);
      if (updated.kind === NodeKind.SECTOR) await this.reattachRoomObjects(updated.roomId);
    }

    await this.totals.recalcTotals(plan.id, true);
    return SeatingPlanNode.findOne({ id: node.id }).lean();
  }

  // ### Один запрос на завершённый drag группы вместо запроса на каждый mousemove
  async BulkUpdateNodes(dto: any) {
    const plan = await getEditablePlan(dto.planId, dto.field);
    const items = Array.isArray(dto.items) ? dto.items : [];
    if (!items.length) return { updated: 0 };

    let updated = 0;

    for (const item of items) {
      const result = await SeatingPlanNode.updateOne(
        { id: Number(item.id), planId: plan.id },
        { $set: { geometry: normalizeGeometry(item.geometry || {}) } },
      );
      updated += result.modifiedCount || 0;
    }

    const rooms: any[] = await SeatingPlanRoom.find({ planId: plan.id }, { id: 1, _id: 0 }).lean();
    for (const room of rooms) await this.reattachRoomObjects(room.id);

    await this.totals.recalcTotals(plan.id, true);
    return { updated };
  }

  async DuplicateNode(dto: any) {
    const { node, plan } = await getNode(dto.id, dto.field);
    const geometry = normalizeGeometry(node.geometry);

    const copy: any = await SeatingPlanNode.create({
      ...stripMeta(node),
      // ### Копия появляется рядом с оригиналом, а не поверх него
      geometry: { ...geometry, x: geometry.x + 16, y: geometry.y + 16 },
    });

    const rows: any[] = await SeatingPlanRow.find({ sectorId: node.id }).lean();
    for (const row of rows) {
      const createdRow: any = await SeatingPlanRow.create({
        ...stripMeta(row),
        sectorId: copy.id,
      });

      const seats: any[] = await SeatingPlanSeat.find({ rowId: row.id }).lean();
      for (const seat of seats)
        await SeatingPlanSeat.create({
          ...stripMeta(seat),
          sectorId: copy.id,
          rowId: createdRow.id,
        });
    }

    if (copy.kind === NodeKind.OBJECT) await this.attachToSector(copy);
    await this.totals.recalcTotals(plan.id, true);

    return SeatingPlanNode.findOne({ id: copy.id }).lean();
  }

  // ### Правило вложенности проверяет бек: иначе через API объект прицепится к сектору
  // ### мимо геометрии и агрегаты Live Review разъедутся.
  async ReparentNode(dto: any) {
    const { node, plan } = await getNode(dto.id, dto.field);

    let parentId: number | null = null;
    if (dto.parentId) {
      const parent: any = await SeatingPlanNode.findOne({
        id: Number(dto.parentId),
        planId: plan.id,
        roomId: node.roomId,
        kind: NodeKind.SECTOR,
      }).lean();
      if (!parent) throw new NotFoundException(ERR.parentNotFound);
      if (centerInside(parent.geometry, node.geometry)) parentId = parent.id;
    }

    await SeatingPlanNode.updateOne({ id: node.id }, { $set: { parentId } });
    await this.totals.recalcTotals(plan.id, true);

    return { id: node.id, parentId };
  }

  async DeleteNode(dto: any) {
    const { node, plan } = await getNode(dto.id, dto.field);

    await Promise.all([
      SeatingPlanSeat.deleteMany({ sectorId: node.id }),
      SeatingPlanRow.deleteMany({ sectorId: node.id }),
      // ### Вложенные объекты не осиротеют: удаляем их вместе с сектором
      SeatingPlanNode.deleteMany({ parentId: node.id }),
      SeatingPlanNode.deleteOne({ id: node.id }),
    ]);

    await this.totals.recalcTotals(plan.id, true);
    return { deleted: true };
  }

  // ### Фото сектора. Новое приходит data-URL'ом и ложится в Media (как обложки событий),
  // ### уже загруженное цепляется по id — но только своё: чужую картинку не прицепить.
  async SetNodePhoto(dto: any) {
    const { node, plan } = await getNode(dto.id, dto.field);

    let photo: number | null = null;
    if (typeof dto.image === "string" && dto.image.trim()) {
      try {
        photo = await this.mediaService.createFromDataUrl(dto.image, dto.field.creator);
      } catch {
        throw new BadRequestException(ERR.invalidImage);
      }
    } else if (dto.mediaId != null) {
      const media = await this.mediaModel
        .findOne({ id: Number(dto.mediaId), user: dto.field.creator })
        .select({ id: 1 })
        .lean<{ id: number }>()
        .exec();
      if (!media) throw new NotFoundException("media_not_found");
      photo = media.id;
    }

    await SeatingPlanNode.updateOne({ id: node.id }, { $set: { photo } });
    await this.totals.touch(plan.id);

    return { id: node.id, photo };
  }

  // ### Ряды всегда соответствуют rowsCount, а оверрайды переживают перегенерацию:
  // ### ключ идентичности ряда — index, а не id. У стоячего сектора рядов нет вовсе.
  private async syncRows(sector: any) {
    const rowsCount = isStandingSector(sector) ? 0 : Number(sector.rowsCount) || 0;
    const seatsPerRow = Number(sector.seatsPerRow) || 0;
    const labels = buildRowLabels(rowsCount, sector.numbering);
    const existing: any[] = await SeatingPlanRow.find({ sectorId: sector.id }).lean();
    const byIndex = new Map(existing.map((row) => [row.index, row]));

    for (let index = 0; index < rowsCount; index++) {
      const current = byIndex.get(index);
      // ### Длина ряда по форме сектора — ровно столько кресел, сколько на холсте
      const seatsInRow = seatsForRow(sector.form, index, rowsCount, seatsPerRow);

      if (!current) {
        await SeatingPlanRow.create({
          planId: sector.planId,
          roomId: sector.roomId,
          sectorId: sector.id,
          index,
          label: labels[index],
          seatsCount: seatsInRow,
        });
        continue;
      }

      const patch: any = { seatsCount: seatsInRow };
      // ### Переименованный вручную ряд не возвращаем к шаблонной подписи
      if (!current.label || current.label === labels[index]) patch.label = labels[index];

      await SeatingPlanRow.updateOne({ id: current.id }, { $set: patch });
      if (seatsInRow < (current.seatsCount || 0))
        await SeatingPlanSeat.deleteMany({ rowId: current.id, index: { $gte: seatsInRow } });
    }

    const extra = existing.filter((row) => row.index >= rowsCount);
    if (extra.length) {
      const ids = extra.map((row) => row.id);
      await SeatingPlanSeat.deleteMany({ rowId: { $in: ids } });
      await SeatingPlanRow.deleteMany({ id: { $in: ids } });
    }

    await this.totals.recalcSector(sector.id);
  }

  // ### Объект относится к сектору, если внутри его границ центр объекта
  private async attachToSector(node: any) {
    const sectors: any[] = await SeatingPlanNode.find({
      roomId: node.roomId,
      kind: NodeKind.SECTOR,
    }).lean();

    const hit = sectors.find((sector) => centerInside(sector.geometry, node.geometry));
    await SeatingPlanNode.updateOne({ id: node.id }, { $set: { parentId: hit?.id ?? null } });
  }

  private async reattachRoomObjects(roomId: number) {
    const objects: any[] = await SeatingPlanNode.find({ roomId, kind: NodeKind.OBJECT }).lean();
    for (const object of objects) await this.attachToSector(object);
  }
}
