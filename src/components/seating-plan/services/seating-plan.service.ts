import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { seatingPlanModel } from "../schemas/seating-plan.schema";
import { seatingPlanRoomModel } from "../schemas/seating-plan-room.schema";
import { seatingPlanNodeModel } from "../schemas/seating-plan-node.schema";
import { seatingPlanRowModel } from "../schemas/seating-plan-row.schema";
import { seatingPlanSeatModel } from "../schemas/seating-plan-seat.schema";
import {
  SeatingPlanStatus,
  SeatSaleStatus,
  SEATING_PLAN_DICTIONARIES,
  DEFAULT_PLAN_CURRENCY,
  DEFAULT_ROOM_TITLE,
  SEATING_PLAN_ERRORS as ERR,
} from "../constants/seating-plan.constants";
import { expandSector } from "../utils/expand.util";
import { normalizePlanCategories } from "../utils/plan-categories.util";
import { stripMeta } from "../utils/node-fields.util";
import { getPlan, getEditablePlan } from "./seating-plan-access";
import { SeatingPlanTotalsService } from "./seating-plan-totals.service";

export type { Field } from "./seating-plan-access";

const SeatingPlan = seatingPlanModel();
const SeatingPlanRoom = seatingPlanRoomModel();
const SeatingPlanNode = seatingPlanNodeModel();
const SeatingPlanRow = seatingPlanRowModel();
const SeatingPlanSeat = seatingPlanSeatModel();

/** Проект схемы зала: создание, шаблоны, копии, удаление и холсты (комнаты). */
@Injectable()
export class SeatingPlanService {
  constructor(private readonly totals: SeatingPlanTotalsService) {}

  // ### Справочники отдаём из кода: значения завязаны на SVG-графику фронта
  Dictionaries() {
    return SEATING_PLAN_DICTIONARIES;
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
    const plan = await getPlan(dto.id, dto.field);

    const [rooms, nodes, rows, seats]: any[] = await Promise.all([
      SeatingPlanRoom.find({ planId: plan.id }).sort({ order: 1 }).lean(),
      SeatingPlanNode.find({ planId: plan.id }).lean(),
      SeatingPlanRow.find({ planId: plan.id }).sort({ index: 1 }).lean(),
      SeatingPlanSeat.find({ planId: plan.id }).lean(),
    ]);

    return { plan, rooms, nodes, rows, seats };
  }

  async Update(dto: any) {
    const plan = await getEditablePlan(dto.id, dto.field);

    const patch: any = {};
    if (dto.title !== undefined) patch.title = dto.title;
    if (dto.currency !== undefined) patch.currency = dto.currency;
    if (dto.preview !== undefined) patch.preview = dto.preview;
    if (dto.categories !== undefined) patch.categories = normalizePlanCategories(dto.categories);

    await SeatingPlan.updateOne({ id: plan.id }, { $set: patch });
    return { id: plan.id, ...patch };
  }

  // ### Модалка Save the project: черновик становится шаблоном и попадает в My Templates.
  // ### Публикацию это не затрагивает — в макете так и написано.
  async Save(dto: any) {
    const plan = await getEditablePlan(dto.id, dto.field);
    const title = String(dto.title || "").trim();
    if (!title) throw new BadRequestException(ERR.titleRequired);

    const totals = await this.totals.recalcTotals(plan.id);

    await SeatingPlan.updateOne(
      { id: plan.id },
      { $set: { title, status: SeatingPlanStatus.TEMPLATE, totals } },
    );

    return { id: plan.id, status: SeatingPlanStatus.TEMPLATE, totals };
  }

  async Duplicate(dto: any) {
    const source = await getPlan(dto.id, dto.field);
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
      // ### Категории нужны снапшоту: по ним публикация подписывает зоны события
      categories: source.categories ?? [],
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
        ...stripMeta(room),
        planId: plan.id,
      });
      roomIds.set(room.id, created.id);
    }

    const nodeIds = new Map<number, number>();
    for (const node of nodes) {
      const created: any = await SeatingPlanNode.create({
        ...stripMeta(node),
        planId: plan.id,
        roomId: roomIds.get(node.roomId),
        parentId: null,
        // ### Зону стоячего сектора проставляет публикация своего снапшота, копии она чужая
        eventSectorId: null,
        eventZoneId: null,
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
        ...stripMeta(row),
        planId: plan.id,
        roomId: roomIds.get(row.roomId),
        sectorId: nodeIds.get(row.sectorId),
      });
      rowIds.set(row.id, created.id);
    }

    for (const seat of seats) {
      await SeatingPlanSeat.create({
        ...stripMeta(seat),
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
    const plan = await getPlan(dto.id, dto.field);

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
    const plan = await getEditablePlan(dto.planId, dto.field);
    const filter: any = { planId: plan.id };
    if (dto.roomId) filter.roomId = Number(dto.roomId);

    const nodes: any[] = await SeatingPlanNode.find(filter, { id: 1, _id: 0 }).lean();
    const ids = nodes.map((node) => node.id);

    await Promise.all([
      SeatingPlanSeat.deleteMany({ sectorId: { $in: ids } }),
      SeatingPlanRow.deleteMany({ sectorId: { $in: ids } }),
      SeatingPlanNode.deleteMany({ id: { $in: ids } }),
    ]);

    await this.totals.recalcTotals(plan.id, true);

    return { cleared: ids.length };
  }

  /* --------------------------------------------------------------- холсты */

  async CreateRoom(dto: any) {
    const plan = await getEditablePlan(dto.planId, dto.field);

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

    await this.totals.touch(plan.id);
    return { id: room.id };
  }

  async UpdateRoom(dto: any) {
    const room: any = await SeatingPlanRoom.findOne({ id: Number(dto.id) }).lean();
    if (!room) throw new NotFoundException(ERR.roomNotFound);
    await getEditablePlan(room.planId, dto.field);

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
    const plan = await getEditablePlan(room.planId, dto.field);

    const count = await SeatingPlanRoom.countDocuments({ planId: plan.id });
    if (count <= 1) throw new ConflictException(ERR.lastRoom);

    await Promise.all([
      SeatingPlanSeat.deleteMany({ planId: plan.id, sectorId: { $in: await this.nodeIdsOfRoom(room.id) } }),
      SeatingPlanRow.deleteMany({ roomId: room.id }),
      SeatingPlanNode.deleteMany({ roomId: room.id }),
      SeatingPlanRoom.deleteOne({ id: room.id }),
    ]);

    await this.totals.recalcTotals(plan.id, true);
    return { deleted: true };
  }

  private async nodeIdsOfRoom(roomId: number) {
    const nodes: any[] = await SeatingPlanNode.find({ roomId }, { id: 1, _id: 0 }).lean();
    return nodes.map((node) => node.id);
  }
}
