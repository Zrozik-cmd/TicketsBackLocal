import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

import mongoose from "mongoose";
import { seatingPlanModel } from "../schemas/seating-plan.schema";
import { seatingPlanRoomModel } from "../schemas/seating-plan-room.schema";
import { seatingPlanNodeModel } from "../schemas/seating-plan-node.schema";
import { seatingPlanRowModel } from "../schemas/seating-plan-row.schema";
import { seatingPlanSeatModel } from "../schemas/seating-plan-seat.schema";
import { IMedia, MediaSchema } from "../../media/schemas/media.schema";
import { MediaService } from "../../media/media.service";

import {
  NodeKind,
  SeatingPlanStatus,
  SeatSaleStatus,
  SECTOR_COLOR_IDS,
  SEATING_PLAN_DICTIONARIES,
  VenueType,
  DEFAULT_PLAN_CURRENCY,
  DEFAULT_ROOM_TITLE,
  SEATING_PLAN_ERRORS as ERR,
} from "../constants/seating-plan.constants";

import { buildRowLabels } from "../utils/numbering.util";
import { centerInside, normalizeGeometry } from "../utils/geometry.util";
import { expandSector, resolveTicket, sectorSeatsTotal } from "../utils/expand.util";
import { seatsForRow } from "../utils/row-shape.util";
import { objectPlaces, primaryCategory, resolveObjectTicket } from "../utils/price-groups.util";
import { isSellableObject, isStandingSector } from "../utils/object-places.util";

/** Ownership: план принадлежит организатору (у менеджера — создавшему его организатору). */
export type Field = { creator: number };

// ### Модели берутся лениво (как везде в Lotus), но под привычными по Tentai именами
const SeatingPlan = seatingPlanModel();
const SeatingPlanRoom = seatingPlanRoomModel();
const SeatingPlanNode = seatingPlanNodeModel();
const SeatingPlanRow = seatingPlanRowModel();
const SeatingPlanSeat = seatingPlanSeatModel();

@Injectable()
export class SeatingPlanService {
  constructor(private readonly mediaService: MediaService) {}

  private get mediaModel(): mongoose.Model<IMedia> {
    return (mongoose.models.Media as mongoose.Model<IMedia>) ?? mongoose.model<IMedia>("Media", MediaSchema);
  }

  // ### Справочники отдаём из кода: значения завязаны на SVG-графику фронта
  Dictionaries() {
    return SEATING_PLAN_DICTIONARIES;
  }

  // ### Ownership всех вложенных сущностей проверяется через их план
  private async getPlan(id: any, field: Field): Promise<any> {
    const plan: any = await SeatingPlan.findOne({ id: Number(id), ...field }).lean();
    if (!plan) throw new NotFoundException(ERR.planNotFound);
    return plan;
  }

  private async getEditablePlan(id: any, field: Field): Promise<any> {
    const plan: any = await this.getPlan(id, field);
    if (plan.status === SeatingPlanStatus.PUBLISHED)
      throw new ConflictException(ERR.planIsPublished);
    if (plan.status === SeatingPlanStatus.ARCHIVED)
      throw new ConflictException(ERR.planIsArchived);
    return plan;
  }

  private async getNode(id: any, field: Field) {
    const node: any = await SeatingPlanNode.findOne({ id: Number(id) }).lean();
    if (!node) throw new NotFoundException(ERR.nodeNotFound);
    const plan = await this.getEditablePlan(node.planId, field);
    return { node, plan };
  }

  private async getRow(id: any, field: Field) {
    const row: any = await SeatingPlanRow.findOne({ id: Number(id) }).lean();
    if (!row) throw new NotFoundException(ERR.rowNotFound);
    const plan = await this.getEditablePlan(row.planId, field);
    return { row, plan };
  }

  private assertColor(color?: string) {
    if (color && !SECTOR_COLOR_IDS.includes(color))
      throw new BadRequestException(ERR.unknownColor);
  }

  // ### Различие макетов Setting Playground и Vanue not sport: у спортивной площадки
  // ### выбирается объект, у остальных сцен — форма.
  private assertVenue(patch: any) {
    if (patch.playgroundType && patch.venueType && patch.venueType !== VenueType.PLAYGROUND)
      throw new BadRequestException(ERR.playgroundTypeRequiresPlayground);
    if (patch.venueType === VenueType.PLAYGROUND && patch.form)
      throw new BadRequestException(ERR.formNotAllowedForPlayground);
  }

  /* ---------------------------------------------------------------- проект */

  async Create(dto: any) {
    const { field, createdBy } = dto;

    const plan: any = await SeatingPlan.create({
      title: dto.title || "",
      status: SeatingPlanStatus.DRAFT,
      ...field,
      createdBy: createdBy ?? null,
      currency: dto.currency || DEFAULT_PLAN_CURRENCY,
      totals: { rooms: 1, sectors: 0, seats: 0 },
    });

    const room: any = await SeatingPlanRoom.create({
      planId: plan.id,
      title: dto.roomTitle || DEFAULT_ROOM_TITLE,
      order: 0,
      isMain: true,
      canvas: {},
    });

    return { id: plan.id, roomId: room.id };
  }

  // ### Полное дерево для загрузки в конструктор. Места отдаём спарсом — их полная
  // ### сетка считается на фронте и на беке одной и той же утилитой expandSector.
  async Get(dto: any) {
    const plan = await this.getPlan(dto.id, dto.field);

    const [rooms, nodes, rows, seats]: any[] = await Promise.all([
      SeatingPlanRoom.find({ planId: plan.id }).sort({ order: 1 }).lean(),
      SeatingPlanNode.find({ planId: plan.id }).lean(),
      SeatingPlanRow.find({ planId: plan.id }).sort({ index: 1 }).lean(),
      SeatingPlanSeat.find({ planId: plan.id }).lean(),
    ]);

    return { plan, rooms, nodes, rows, seats };
  }

  async Update(dto: any) {
    const plan = await this.getEditablePlan(dto.id, dto.field);

    const patch: any = {};
    if (dto.title !== undefined) patch.title = dto.title;
    if (dto.currency !== undefined) patch.currency = dto.currency;
    if (dto.preview !== undefined) patch.preview = dto.preview;

    await SeatingPlan.updateOne({ id: plan.id }, { $set: patch });
    return { id: plan.id, ...patch };
  }

  // ### Модалка Save the project: черновик становится шаблоном и попадает в My Templates.
  // ### Публикацию это не затрагивает — в макете так и написано.
  async Save(dto: any) {
    const plan = await this.getEditablePlan(dto.id, dto.field);
    const title = String(dto.title || "").trim();
    if (!title) throw new BadRequestException(ERR.titleRequired);

    const totals = await this.recalcTotals(plan.id);

    await SeatingPlan.updateOne(
      { id: plan.id },
      { $set: { title, status: SeatingPlanStatus.TEMPLATE, totals } },
    );

    return { id: plan.id, status: SeatingPlanStatus.TEMPLATE, totals };
  }

  async Duplicate(dto: any) {
    const source = await this.getPlan(dto.id, dto.field);
    const copy = await this.ClonePlan(source, {
      title: dto.title || `${source.title} copy`,
      status: SeatingPlanStatus.DRAFT,
      sourcePlanId: source.id,
    });

    return { id: copy.plan.id };
  }

  // ### Копия дерева плана. Используется и кнопкой Duplicate, и публикацией:
  // ### опубликованный план — это снапшот, исходный при публикации не мутирует.
  async ClonePlan(source: any, overrides: any = {}) {

    const plan: any = await SeatingPlan.create({
      title: source.title,
      status: SeatingPlanStatus.DRAFT,
      creator: source.creator,
      createdBy: source.createdBy ?? null,
      sourcePlanId: source.id,
      currency: source.currency,
      totals: source.totals,
      version: 1,
      ...overrides,
    });

    const [rooms, nodes, rows, seats]: any[] = await Promise.all([
      SeatingPlanRoom.find({ planId: source.id }).lean(),
      SeatingPlanNode.find({ planId: source.id }).lean(),
      SeatingPlanRow.find({ planId: source.id }).lean(),
      SeatingPlanSeat.find({ planId: source.id }).lean(),
    ]);

    // ### Копия перенумеровывается: связи внутри дерева держатся на id, а они новые
    const roomIds = new Map<number, number>();
    for (const room of rooms) {
      const created: any = await SeatingPlanRoom.create({
        ...this.strip(room),
        planId: plan.id,
      });
      roomIds.set(room.id, created.id);
    }

    const nodeIds = new Map<number, number>();
    for (const node of nodes) {
      const created: any = await SeatingPlanNode.create({
        ...this.strip(node),
        planId: plan.id,
        roomId: roomIds.get(node.roomId),
        parentId: null,
      });
      nodeIds.set(node.id, created.id);
    }

    // ### parentId проставляем вторым проходом: родитель мог копироваться позже ребёнка
    for (const node of nodes) {
      if (!node.parentId) continue;
      await SeatingPlanNode.updateOne(
        { id: nodeIds.get(node.id) },
        { $set: { parentId: nodeIds.get(node.parentId) ?? null } },
      );
    }

    const rowIds = new Map<number, number>();
    for (const row of rows) {
      const created: any = await SeatingPlanRow.create({
        ...this.strip(row),
        planId: plan.id,
        roomId: roomIds.get(row.roomId),
        sectorId: nodeIds.get(row.sectorId),
      });
      rowIds.set(row.id, created.id);
    }

    for (const seat of seats) {
      await SeatingPlanSeat.create({
        ...this.strip(seat),
        planId: plan.id,
        sectorId: nodeIds.get(seat.sectorId),
        rowId: rowIds.get(seat.rowId),
        // ### Состояние продажи копии не нужно: у неё своя публикация (или никакой)
        eventId: null,
        salePrice: null,
        saleCategory: null,
        eventSectorId: null,
        eventZoneId: null,
        saleStatus: SeatSaleStatus.FREE,
        holdUntil: null,
        orderId: null,
        ticketId: null,
      });
    }

    return { plan, roomIds, nodeIds, rowIds };
  }

  async Delete(dto: any) {
    const plan = await this.getPlan(dto.id, dto.field);

    if (plan.status === SeatingPlanStatus.PUBLISHED) {
      const sold = await SeatingPlanSeat.countDocuments({
        planId: plan.id,
        saleStatus: { $in: ["SOLD", "HELD"] },
      });
      // ### Проданное место переживает удаление плана: билет должен читаться и потом
      if (sold) throw new ConflictException(ERR.planHasSoldTickets);
    }

    await Promise.all([
      SeatingPlanSeat.deleteMany({ planId: plan.id }),
      SeatingPlanRow.deleteMany({ planId: plan.id }),
      SeatingPlanNode.deleteMany({ planId: plan.id }),
      SeatingPlanRoom.deleteMany({ planId: plan.id }),
      SeatingPlan.deleteOne({ id: plan.id }),
    ]);

    return { deleted: true };
  }

  // ### Экран My Templates. transform в ValidationPipe выключен, поэтому числа руками.
  async List(dto: any) {
    const page = Math.max(1, Number(dto.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(dto.limit) || 20));
    const order = dto.order === "asc" ? 1 : -1;
    // ### Сортировка экрана My Templates: по названию или дате создания
    const sortField = dto.sort === "title" ? "title" : "createdAt";
    const sort: any = { [sortField]: order, id: order };

    const filter: any = {
      ...dto.field,
      status: dto.status || SeatingPlanStatus.TEMPLATE,
    };
    if (dto.search)
      filter.title = { $regex: String(dto.search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };

    const [items, total] = await Promise.all([
      SeatingPlan.find(filter, { _id: 0, id: 1, title: 1, status: 1, totals: 1, createdAt: 1, updatedAt: 1 })
        .sort(sort)
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      SeatingPlan.countDocuments(filter),
    ]);

    return { items, total, page, limit };
  }

  // ### Очистка холста перед повторной загрузкой проекта. Конструктор отправляет
  // ### раскладку целиком, и без этого второе сохранение положило бы вторую копию
  // ### всех секторов поверх первой.
  async ClearCanvas(dto: any) {
    const plan = await this.getEditablePlan(dto.planId, dto.field);
    const filter: any = { planId: plan.id };
    if (dto.roomId) filter.roomId = Number(dto.roomId);

    const nodes: any[] = await SeatingPlanNode.find(filter, { id: 1, _id: 0 }).lean();
    const ids = nodes.map((node) => node.id);

    await Promise.all([
      SeatingPlanSeat.deleteMany({ sectorId: { $in: ids } }),
      SeatingPlanRow.deleteMany({ sectorId: { $in: ids } }),
      SeatingPlanNode.deleteMany({ id: { $in: ids } }),
    ]);

    await this.recalcTotals(plan.id, true);

    return { cleared: ids.length };
  }

  /* --------------------------------------------------------------- холсты */

  async CreateRoom(dto: any) {
    const plan = await this.getEditablePlan(dto.planId, dto.field);

    // ### Модалка Add Room заодно переименовывает основной холст — это второй апдейт
    if (dto.mainRoomTitle)
      await SeatingPlanRoom.updateOne(
        { planId: plan.id, isMain: true },
        { $set: { title: dto.mainRoomTitle } },
      );

    const count = await SeatingPlanRoom.countDocuments({ planId: plan.id });

    const room: any = await SeatingPlanRoom.create({
      planId: plan.id,
      title: dto.title || `Room #${count + 1}`,
      order: count,
      isMain: count === 0,
      canvas: dto.canvas || {},
    });

    await this.touch(plan.id);
    return { id: room.id };
  }

  async UpdateRoom(dto: any) {
    const room: any = await SeatingPlanRoom.findOne({ id: Number(dto.id) }).lean();
    if (!room) throw new NotFoundException(ERR.roomNotFound);
    await this.getEditablePlan(room.planId, dto.field);

    const patch: any = {};
    if (dto.title !== undefined) patch.title = dto.title;
    if (dto.order !== undefined) patch.order = dto.order;
    if (dto.canvas !== undefined) patch.canvas = dto.canvas;

    await SeatingPlanRoom.updateOne({ id: room.id }, { $set: patch });
    return { id: room.id, ...patch };
  }

  async DeleteRoom(dto: any) {
    const room: any = await SeatingPlanRoom.findOne({ id: Number(dto.id) }).lean();
    if (!room) throw new NotFoundException(ERR.roomNotFound);
    const plan = await this.getEditablePlan(room.planId, dto.field);

    const count = await SeatingPlanRoom.countDocuments({ planId: plan.id });
    if (count <= 1) throw new ConflictException(ERR.lastRoom);

    await Promise.all([
      SeatingPlanSeat.deleteMany({ planId: plan.id, sectorId: { $in: await this.nodeIdsOfRoom(room.id) } }),
      SeatingPlanRow.deleteMany({ roomId: room.id }),
      SeatingPlanNode.deleteMany({ roomId: room.id }),
      SeatingPlanRoom.deleteOne({ id: room.id }),
    ]);

    await this.recalcTotals(plan.id, true);
    return { deleted: true };
  }

  private async nodeIdsOfRoom(roomId: number) {
    const nodes: any[] = await SeatingPlanNode.find({ roomId }, { id: 1, _id: 0 }).lean();
    return nodes.map((node) => node.id);
  }

  /* ----------------------------------------------------------------- узлы */

  async CreateNode(dto: any) {
    const plan = await this.getEditablePlan(dto.planId, dto.field);
    const room: any = await SeatingPlanRoom.findOne({ id: Number(dto.roomId), planId: plan.id }).lean();
    if (!room) throw new NotFoundException(ERR.roomNotFound);

    this.assertColor(dto.color);
    this.assertVenue(dto);

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
      isSellable: isSellableObject(dto),
      tableNumber: dto.tableNumber ?? null,
    });

    // ### Add Sector сразу создаёт ряды: конструктор рисует их без второго запроса
    if (node.kind === NodeKind.SECTOR) await this.syncRows(node);
    if (node.kind === NodeKind.OBJECT) await this.attachToSector(node);

    await this.recalcTotals(plan.id, true);
    return SeatingPlanNode.findOne({ id: node.id }).lean();
  }

  async UpdateNode(dto: any) {
    const { node, plan } = await this.getNode(dto.id, dto.field);

    this.assertColor(dto.color);
    this.assertVenue({ venueType: dto.venueType ?? node.venueType, playgroundType: dto.playgroundType, form: dto.form });

    const patch: any = {};
    const direct = [
      "title", "color", "locked", "venueType", "playgroundType", "form",
      "sectorType", "seatType", "numbering", "ticket", "objectType", "tableNumber", "decor",
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

    await this.recalcTotals(plan.id, true);
    return SeatingPlanNode.findOne({ id: node.id }).lean();
  }

  // ### Один запрос на завершённый drag группы вместо запроса на каждый mousemove
  async BulkUpdateNodes(dto: any) {
    const plan = await this.getEditablePlan(dto.planId, dto.field);
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

    await this.recalcTotals(plan.id, true);
    return { updated };
  }

  async DuplicateNode(dto: any) {
    const { node, plan } = await this.getNode(dto.id, dto.field);
    const geometry = normalizeGeometry(node.geometry);

    const copy: any = await SeatingPlanNode.create({
      ...this.strip(node),
      // ### Копия появляется рядом с оригиналом, а не поверх него
      geometry: { ...geometry, x: geometry.x + 16, y: geometry.y + 16 },
    });

    const rows: any[] = await SeatingPlanRow.find({ sectorId: node.id }).lean();
    for (const row of rows) {
      const createdRow: any = await SeatingPlanRow.create({
        ...this.strip(row),
        sectorId: copy.id,
      });

      const seats: any[] = await SeatingPlanSeat.find({ rowId: row.id }).lean();
      for (const seat of seats)
        await SeatingPlanSeat.create({
          ...this.strip(seat),
          sectorId: copy.id,
          rowId: createdRow.id,
        });
    }

    if (copy.kind === NodeKind.OBJECT) await this.attachToSector(copy);
    await this.recalcTotals(plan.id, true);

    return SeatingPlanNode.findOne({ id: copy.id }).lean();
  }

  // ### Правило вложенности проверяет бек: иначе через API объект прицепится к сектору
  // ### мимо геометрии и агрегаты Live Review разъедутся.
  async ReparentNode(dto: any) {
    const { node, plan } = await this.getNode(dto.id, dto.field);

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
    await this.recalcTotals(plan.id, true);

    return { id: node.id, parentId };
  }

  async DeleteNode(dto: any) {
    const { node, plan } = await this.getNode(dto.id, dto.field);

    await Promise.all([
      SeatingPlanSeat.deleteMany({ sectorId: node.id }),
      SeatingPlanRow.deleteMany({ sectorId: node.id }),
      // ### Вложенные объекты не осиротеют: удаляем их вместе с сектором
      SeatingPlanNode.deleteMany({ parentId: node.id }),
      SeatingPlanNode.deleteOne({ id: node.id }),
    ]);

    await this.recalcTotals(plan.id, true);
    return { deleted: true };
  }

  // ### Фото сектора. Новое приходит data-URL'ом и ложится в Media (как обложки событий),
  // ### уже загруженное цепляется по id — но только своё: чужую картинку не прицепить.
  async SetNodePhoto(dto: any) {
    const { node, plan } = await this.getNode(dto.id, dto.field);

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
    await this.touch(plan.id);

    return { id: node.id, photo };
  }

  /* ------------------------------------------------------- ряды и места */

  async UpdateRow(dto: any) {
    const { row, plan } = await this.getRow(dto.id, dto.field);
    this.assertColor(dto.color);

    const patch: any = {};
    ["label", "seatType", "color", "ticket", "numbering", "geometry"].forEach((key) => {
      if (dto[key] !== undefined) patch[key] = dto[key];
    });
    if (dto.seatsCount !== undefined) patch.seatsCount = Number(dto.seatsCount) || 0;

    await SeatingPlanRow.updateOne({ id: row.id }, { $set: patch });

    // ### Ряд стал короче — оверрайды выпавших мест больше не к чему привязать
    if (patch.seatsCount !== undefined)
      await SeatingPlanSeat.deleteMany({ rowId: row.id, index: { $gte: patch.seatsCount } });

    await this.recalcSector(row.sectorId);
    await this.recalcTotals(plan.id);

    return SeatingPlanRow.findOne({ id: row.id }).lean();
  }

  // ### Применение настройки ко "Всему сектору" из правой панели
  async BulkUpdateRows(dto: any) {
    const { node, plan } = await this.getNode(dto.sectorId, dto.field);
    const patch: any = {};

    ["label", "seatType", "color", "ticket", "numbering"].forEach((key) => {
      if (dto.patch?.[key] !== undefined) patch[key] = dto.patch[key];
    });
    if (dto.patch?.seatsCount !== undefined) patch.seatsCount = Number(dto.patch.seatsCount) || 0;
    if (!Object.keys(patch).length) throw new BadRequestException(ERR.emptyPatch);

    const result = await SeatingPlanRow.updateMany({ sectorId: node.id }, { $set: patch });

    await this.recalcSector(node.id);
    await this.recalcTotals(plan.id);

    return { updated: result.modifiedCount || 0 };
  }

  // ### Место существует в базе только когда у него есть что переопределять
  async UpdateSeat(dto: any) {
    const { row, plan } = await this.getRow(dto.rowId, dto.field);
    const index = Number(dto.index);
    if (!Number.isInteger(index) || index < 0 || index >= row.seatsCount)
      throw new BadRequestException(ERR.seatIndexOutOfRange);

    this.assertColor(dto.color);

    const patch: any = {};
    ["label", "seatType", "color", "ticket", "disabled"].forEach((key) => {
      if (dto[key] !== undefined) patch[key] = dto[key];
    });

    await this.upsertSeatOverride(row, index, patch);

    if (dto.disabled !== undefined) {
      await this.recalcSector(row.sectorId);
      await this.recalcTotals(plan.id);
    }

    return SeatingPlanSeat.findOne({ rowId: row.id, index }).lean();
  }

  async BulkUpdateSeats(dto: any) {
    const { node, plan } = await this.getNode(dto.sectorId, dto.field);
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

    await this.recalcSector(node.id);
    await this.recalcTotals(plan.id);

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
    const { row } = await this.getRow(dto.rowId, dto.field);
    await SeatingPlanSeat.deleteOne({ rowId: row.id, index: Number(dto.index) });
    await this.recalcSector(row.sectorId);
    return { reset: true };
  }

  /* ------------------------------------------------------ агрегаты и вьюхи */

  // ### Развёрнутая сетка сектора с посчитанными подписями — для превью без материализации
  async ExpandSector(dto: any) {
    const { node } = await this.getNode(dto.id, dto.field);
    if (node.kind !== NodeKind.SECTOR) throw new BadRequestException(ERR.notASector);

    const [rows, seats]: any[] = await Promise.all([
      SeatingPlanRow.find({ sectorId: node.id }).sort({ index: 1 }).lean(),
      SeatingPlanSeat.find({ sectorId: node.id }).lean(),
    ]);

    return { sector: node, rows: expandSector(node, rows, seats) };
  }

  // ### Live Review: по всему проекту либо по одному выбранному сектору
  async Summary(dto: any) {
    const plan = await this.getPlan(dto.id, dto.field);

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
        const expanded = expandSector(sector, sectorRows, sectorSeats);

        const byCategory: Record<string, number> = {};
        const bySeatType: Record<string, number> = {};

        expanded.forEach((row) =>
          row.seats.forEach((seat) => {
            if (seat.disabled) return;
            (seat.ticket.categories || []).forEach((category) => {
              byCategory[category] = (byCategory[category] || 0) + 1;
            });
            if (seat.seatType) bySeatType[seat.seatType] = (bySeatType[seat.seatType] || 0) + 1;
          }),
        );

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

  /* --------------------------------------------------------------- служебное */

  private strip(doc: any) {
    const { _id, id, __v, createdAt, updatedAt, ...rest } = doc;
    return rest;
  }

  private touch(planId: number) {
    return SeatingPlan.updateOne({ id: planId }, { $set: { updatedAt: new Date() } });
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

    await this.recalcSector(sector.id);
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

  private async recalcSector(sectorId: number) {
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
  private async recalcTotals(planId: number, persist = false) {
    const [rooms, nodes, rows, seats]: any[] = await Promise.all([
      SeatingPlanRoom.countDocuments({ planId }),
      SeatingPlanNode.find({ planId }).lean(),
      SeatingPlanRow.find({ planId }).lean(),
      SeatingPlanSeat.find({ planId }).lean(),
    ]);

    const byCategory: Record<string, number> = {};
    const bySeatType: Record<string, number> = {};
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

        if (isStandingSector(sector)) return;

        expandSector(sector, sectorRows, sectorSeats).forEach((row) =>
          row.seats.forEach((seat) => {
            if (seat.disabled) return;
            (seat.ticket.categories || []).forEach((category) => {
              byCategory[category] = (byCategory[category] || 0) + 1;
            });
            if (seat.seatType) bySeatType[seat.seatType] = (bySeatType[seat.seatType] || 0) + 1;
          }),
        );
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
