import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import mongoose from 'mongoose';

import { EventSchema, type IEvent, type ISector, type IZone } from '../../events/schemas/event.schema';
import { EventsService } from '../../events/events.service';
import type { UpdateEventDto } from '../../events/dto/update-event.dto';
import { MockOrderSchema, type IMockOrder } from '../../mock-orders/schemas/mock-order.schema';
import { TicketSchema, type ITicket } from '../../tickets/schemas/ticket.schema';

import { seatingPlanModel } from '../schemas/seating-plan.schema';
import { seatingPlanNodeModel } from '../schemas/seating-plan-node.schema';
import { seatingPlanRoomModel } from '../schemas/seating-plan-room.schema';
import { seatingPlanRowModel } from '../schemas/seating-plan-row.schema';
import { seatingPlanSeatModel } from '../schemas/seating-plan-seat.schema';

import { SeatingPlanService, type Field } from './seating-plan.service';
import { isSellableObject, objectLabel, objectPlaces, ROWS_SOURCE, type PriceGroup } from '../utils/price-groups.util';
import { checkPlan, groupBy, planPriceGroups, unpricedProblem } from '../utils/plan-check.util';
import { expandSector } from '../utils/expand.util';
import { linkStandingZones } from '../standing-zones';
import { categoryTitle, type Localized } from '../utils/plan-categories.util';
import { SEPARATE_SEATS_TITLE, zoneTitle } from '../utils/zone-titles.util';
import {
  Availability,
  NodeKind,
  PLAN_SECTOR_ID_PREFIX,
  SEATING_PLAN_ERRORS as ERR,
  SECTOR_COLORS,
  SeatingPlanStatus,
  SeatSaleStatus,
  ObjectType,
} from '../constants/seating-plan.constants';
import { HOLDS_SEAT_ORDER_STATUSES } from '../../mock-orders/constants/order-status-sets.constant';

const SeatingPlan = seatingPlanModel();
const SeatingPlanNode = seatingPlanNodeModel();
const SeatingPlanRoom = seatingPlanRoomModel();
const SeatingPlanRow = seatingPlanRowModel();
const SeatingPlanSeat = seatingPlanSeatModel();

const BATCH = 1000;
const BUSY = [SeatSaleStatus.SOLD, SeatSaleStatus.HELD];
/** Заказы, которые держат или уже продали места зоны (как в EventsService). */
const PLAN_ID_REGEX = new RegExp(`^${PLAN_SECTOR_ID_PREFIX}`);

const SEPARATE_SEATS_KEY = 'objects';

type ProjectedGroup = PriceGroup & { eventSectorId: string; eventZoneId: string; categoryTitle: Localized };

/**
 * Публикация схемы: снапшот плана и проекция его в тарифы события.
 *
 * В Lotus Arena билеты продаются по зонам события (`sectors[].zones[]`), поэтому каждая
 * группа «сектор + класс + цена» становится зоной, а сектор схемы — сектором события.
 * Пишется это штатным `EventsService.update`: тот же запрет трогать проданные зоны и
 * тот же возврат опубликованного (ACTIVE) события на модерацию при смене тарифов, что и
 * у правки из карточки. Секторы, заведённые в карточке руками, остаются как были —
 * порождённые схемой отличаются префиксом id `plan-`.
 *
 * Транзакций нет (Mongo без реплики), поэтому порядок такой: снапшот целиком,
 * затем тарифы события, затем места и последней — ссылка `Event.seatingPlanId`.
 */
@Injectable()
export class SeatingPlanPublishService {
  private readonly logger = new Logger(SeatingPlanPublishService.name);

  constructor(
    private readonly plans: SeatingPlanService,
    private readonly eventsService: EventsService,
  ) {}

  private get eventModel(): mongoose.Model<IEvent> {
    return (mongoose.models.Event as mongoose.Model<IEvent>) ?? mongoose.model<IEvent>('Event', EventSchema);
  }

  private get mockOrderModel(): mongoose.Model<IMockOrder> {
    return (
      (mongoose.models.MockOrder as mongoose.Model<IMockOrder>) ??
      mongoose.model<IMockOrder>('MockOrder', MockOrderSchema)
    );
  }

  private get ticketModel(): mongoose.Model<ITicket> {
    return (mongoose.models.Ticket as mongoose.Model<ITicket>) ?? mongoose.model<ITicket>('Ticket', TicketSchema);
  }

  async Publish(dto: { id: number; eventId: number; field: Field }) {
    const source: any = await SeatingPlan.findOne({ id: Number(dto.id), ...dto.field }).lean();
    if (!source) throw new NotFoundException(ERR.planNotFound);
    if (source.status === SeatingPlanStatus.ARCHIVED) throw new ConflictException(ERR.planIsArchived);

    const event = await this.loadOwnEvent(dto.eventId, dto.field);

    // Перепубликация поверх проданных билетов запрещена: место, за которое заплатили,
    // не должно менять идентичность.
    const current: any = await SeatingPlan.findOne({
      eventId: event.id,
      status: SeatingPlanStatus.PUBLISHED,
    }).lean();
    if (await this.hasPlanSales(event.id, current?.id)) throw new ConflictException(ERR.planHasSoldTickets);

    const warnings = await this.validatePlan(source.id);

    const snapshot = await this.plans.ClonePlan(source, {
      status: SeatingPlanStatus.PUBLISHED,
      eventId: event.id,
      sourcePlanId: source.status === SeatingPlanStatus.PUBLISHED ? source.sourcePlanId : source.id,
      version: (Number(source.version) || 1) + 1,
    });

    const groups = await this.projectGroups(snapshot.plan.id);
    let updatedEvent: IEvent;
    try {
      updatedEvent = await this.writeEventSectors(event, groups, dto.field);
    } catch (error) {
      // Тарифы не записались — недостроенный снапшот никому не нужен.
      await this.dropPlanTree(snapshot.plan.id);
      throw error;
    }

    const seats = await this.materializeSeats(snapshot.plan.id, event.id, groups);
    await linkStandingZones(snapshot.plan.id, groups);

    if (current) await this.Archive(current.id);

    // Точечный апдейт: ссылки на схему нет в DTO события, и на модерацию она не влияет.
    await this.eventModel.updateOne({ id: event.id }, { $set: { seatingPlanId: snapshot.plan.id } }).exec();
    await SeatingPlan.updateOne({ id: snapshot.plan.id }, { $set: { publishedAt: new Date() } });

    return {
      id: snapshot.plan.id,
      eventId: event.id,
      eventStatus: updatedEvent.status,
      sectors: new Set(groups.map((group) => group.eventSectorId)).size,
      zones: groups.length,
      seats,
      warnings,
    };
  }

  /**
   * Пока билеты не проданы, схему переиздают целиком. Когда проданы — менять можно
   * только то, что не трогает идентичность места: цену, доступность, подпись, цвет, фото.
   * Сетка (rowsCount, seatsPerRow, нумерация, удаление рядов) остаётся как есть.
   */
  async PatchPublished(dto: { id: number; nodes: any[]; field: Field }) {
    const plan: any = await SeatingPlan.findOne({ id: Number(dto.id), ...dto.field }).lean();
    if (!plan) throw new NotFoundException(ERR.planNotFound);
    if (plan.status !== SeatingPlanStatus.PUBLISHED) throw new ConflictException(ERR.planIsNotPublished);

    const nodes = Array.isArray(dto.nodes) ? dto.nodes : [];
    if (!nodes.length) throw new BadRequestException(ERR.emptyPatch);

    let updated = 0;
    let ticketsChanged = false;
    const before: any[] = [];

    for (const item of nodes) {
      const node: any = await SeatingPlanNode.findOne({ id: Number(item.id), planId: plan.id }).lean();
      if (!node) continue;
      before.push(node);

      const patch: any = {};
      if (item.title !== undefined) patch.title = item.title;
      if (item.color !== undefined) patch.color = item.color;
      if (item.photo !== undefined) patch.photo = item.photo;
      if (item.ticket !== undefined) patch.ticket = { ...(node.ticket || {}), ...item.ticket };

      await SeatingPlanNode.updateOne({ id: node.id }, { $set: patch });
      updated += 1;

      if (item.title !== undefined || item.color !== undefined) ticketsChanged = true;
      if (item.ticket !== undefined) ticketsChanged = true;
    }

    // Тарифы события пересобираются из снапшота с теми же id зон: проданная зона
    // сохраняет идентичность, а правила Lotus решают, можно ли менять её цену и места.
    let zones = 0;
    if (ticketsChanged && plan.eventId) {
      const event = await this.loadOwnEvent(plan.eventId, dto.field);
      const groups = await this.projectGroups(plan.id);
      // Патч, после которого место в продаже стоит 0, откатывается: зоны события не тронуты
      const unpriced = unpricedProblem(groups);
      if (unpriced) {
        await this.restoreNodes(before);
        throw new HttpException(unpriced, unpriced.statusCode);
      }
      await this.writeEventSectors(event, groups, dto.field);
      await this.relinkSeats(plan.id, groups);
      await linkStandingZones(plan.id, groups);
      zones = groups.length;
    }

    await SeatingPlan.updateOne({ id: plan.id }, { $set: { updatedAt: new Date() } });
    return { id: plan.id, nodes: updated, zones };
  }

  /** Снять публикацию можно только пока по зонам схемы ничего не продано. */
  async Unpublish(dto: { id: number; field: Field }) {
    const plan: any = await SeatingPlan.findOne({ id: Number(dto.id), ...dto.field }).lean();
    if (!plan) throw new NotFoundException(ERR.planNotFound);
    if (plan.status !== SeatingPlanStatus.PUBLISHED) throw new ConflictException(ERR.planIsNotPublished);

    if (plan.eventId) {
      if (await this.hasPlanSales(plan.eventId, plan.id)) throw new ConflictException(ERR.planHasSoldTickets);
      const event = await this.loadOwnEvent(plan.eventId, dto.field);
      // Порождённые схемой тарифы уходят, заведённые в карточке руками остаются.
      await this.writeEventSectors(event, [], dto.field);
      await this.eventModel.updateOne({ id: plan.eventId }, { $unset: { seatingPlanId: '' } }).exec();
    }

    await SeatingPlanSeat.deleteMany({ planId: plan.id });
    await SeatingPlan.updateOne({ id: plan.id }, { $set: { status: SeatingPlanStatus.ARCHIVED } });

    return { id: plan.id, status: SeatingPlanStatus.ARCHIVED };
  }

  /** Архив вместо удаления: проданный билет должен читаться и после замены схемы. */
  async Archive(planId: number) {
    await SeatingPlan.updateOne({ id: Number(planId) }, { $set: { status: SeatingPlanStatus.ARCHIVED } });
    return { archived: true };
  }

  /** При удалении события: планы в архив, свободные места убираем. */
  async ArchiveByEvent(eventId: number) {
    const plans: any[] = await SeatingPlan.find({ eventId: Number(eventId) }).lean();
    for (const plan of plans) await this.Archive(plan.id);

    await SeatingPlanSeat.deleteMany({ eventId: Number(eventId), saleStatus: { $nin: BUSY } });
    return { archived: plans.length };
  }

  /* ------------------------------------------------------------------ служебное */

  private async loadOwnEvent(eventId: number, field: Field): Promise<IEvent> {
    const event = await this.eventModel
      .findOne({ id: Number(eventId), creator: field.creator, softDeleted: { $ne: true } })
      .lean<IEvent>()
      .exec();
    if (!event) throw new NotFoundException(ERR.eventNotFound);
    if (event.archivedByOrganizer === true) throw new ConflictException(ERR.eventArchived);
    return event;
  }

  /**
   * Есть ли продажи по зонам схемы: живые заказы (ожидают оплаты или оплачены), билеты
   * или занятые места снапшота. Проверяется до любых записей.
   */
  private async hasPlanSales(eventId: number, planId?: number): Promise<boolean> {
    const [order, ticket, seat] = await Promise.all([
      this.mockOrderModel
        .exists({ event: eventId, status: { $in: HOLDS_SEAT_ORDER_STATUSES }, 'tickets.sectorId': PLAN_ID_REGEX })
        .exec(),
      // Билет хранит сектор в поле `sector` (у строки заказа — `sectorId`)
      this.ticketModel.exists({ eventId, sector: PLAN_ID_REGEX }).exec(),
      planId ? SeatingPlanSeat.exists({ planId, saleStatus: { $in: BUSY } }) : null,
    ]);
    return Boolean(order || ticket || seat);
  }

  /** Сектор события `plan-<id узла>` и зона `plan-<id узла>-<класс>-<n>` для каждой группы. */
  private async projectGroups(planId: number): Promise<ProjectedGroup[]> {
    const [plan, nodes, rows, seats]: any[] = await Promise.all([
      SeatingPlan.findOne({ id: planId }).select({ categories: 1 }).lean(),
      SeatingPlanNode.find({ planId }).lean(),
      SeatingPlanRow.find({ planId }).lean(),
      SeatingPlanSeat.find({ planId }).lean(),
    ]);

    const groups = planPriceGroups(nodes, rows, seats).map((group) => ({
      ...group,
      categoryTitle: categoryTitle(group.category, plan?.categories),
    }));

    // Порядковый номер цены внутри «сектор + источник + класс»: смена цены всего сектора
    // не меняет id зоны, и проданная зона остаётся узнаваемой.
    const ordinals = new Map<string, number>();
    return groups.map((group) => {
      const owner = group.sectorId ?? SEPARATE_SEATS_KEY;
      const eventSectorId = `${PLAN_SECTOR_ID_PREFIX}${owner}`;
      if (group.objectId != null) {
        return { ...group, eventSectorId, eventZoneId: `${eventSectorId}-table-${group.objectId}` };
      }
      const key = `${owner}|${group.source}|${group.category}`;
      const n = ordinals.get(key) ?? 0;
      ordinals.set(key, n + 1);
      const source = group.source === ROWS_SOURCE ? '' : `${group.source}-`;
      return { ...group, eventSectorId, eventZoneId: `${eventSectorId}-${source}${group.category}-${n}` };
    });
  }

  /**
   * Секторы события = заведённые руками + порождённые схемой. Пишется штатным update:
   * проданные зоны защищены, опубликованное событие уходит на модерацию, если тарифы
   * изменились.
   */
  private async writeEventSectors(event: IEvent, groups: ProjectedGroup[], field: Field): Promise<IEvent> {
    const manual = (event.sectors ?? []).filter((sector) => !PLAN_ID_REGEX.test(sector.id));
    const sectors: ISector[] = [...manual.map((sector) => this.plainSector(sector)), ...this.toEventSectors(groups)];
    const planSeats = groups.reduce((sum, group) => sum + group.seatsCount, 0);

    const dto = {
      sectors,
      ...(planSeats > 0 ? { seatingPlanSeats: planSeats } : {}),
    } as unknown as UpdateEventDto;

    return this.eventsService.update(String(event.id), dto, String(field.creator));
  }

  /** Только поля, которые организатор сам отправляет из карточки (без живых счётчиков). */
  private plainSector(sector: ISector): ISector {
    return {
      id: sector.id,
      color: sector.color,
      name: sector.name,
      zones: (sector.zones ?? []).map((zone: IZone) => ({
        id: zone.id,
        name: zone.name,
        seats: zone.seats,
        isFree: zone.isFree,
        price: zone.price,
        currency: zone.currency,
      })),
    } as ISector;
  }

  private toEventSectors(groups: ProjectedGroup[]): ISector[] {
    const bySector = new Map<string, ProjectedGroup[]>();
    groups.forEach((group) => {
      const bucket = bySector.get(group.eventSectorId) ?? [];
      bucket.push(group);
      bySector.set(group.eventSectorId, bucket);
    });

    return [...bySector.values()].map((sectorGroups) => {
      const first = sectorGroups[0];
      const separate = first.sectorId == null;
      const title = first.sectorTitle?.trim() || `Sector ${first.sectorId}`;
      const color = SECTOR_COLORS.find((item) => item.id === first.sectorColor)?.hex ?? SECTOR_COLORS[0].hex;
      // Несколько цен в одном «источник + класс» — к подписи зоны добавляется цена.
      const perKind = new Map<string, number>();
      sectorGroups.forEach((group) => {
        const key = `${group.source}|${group.category}`;
        perKind.set(key, (perKind.get(key) ?? 0) + 1);
      });

      return {
        id: first.eventSectorId,
        color,
        name: separate ? SEPARATE_SEATS_TITLE : { th: title, en: title, ru: title },
        zones: sectorGroups.map((group) => ({
          id: group.eventZoneId,
          name: zoneTitle(group, group.categoryTitle, (perKind.get(`${group.source}|${group.category}`) ?? 0) > 1),
          seats: group.seatsCount,
          isFree: !group.price,
          price: group.price,
          currency: 'THB',
        })),
      } as unknown as ISector;
    });
  }

  /**
   * Проверяем то, что после публикации уже не починить: пустую схему, отсутствие
   * продаваемых мест и одинаковые подписи рядов внутри сектора.
   */
  private async validatePlan(planId: number) {
    const [nodes, rows, seats]: any[] = await Promise.all([
      SeatingPlanNode.find({ planId }).lean(),
      SeatingPlanRow.find({ planId }).lean(),
      SeatingPlanSeat.find({ planId }).lean(),
    ]);

    const { problem, warnings } = checkPlan(nodes, rows, seats);
    if (problem) throw new HttpException(problem, problem.statusCode);
    return warnings;
  }

  /**
   * В опубликованном плане места материализуются полностью: продаже нужен документ с
   * состоянием. Материализуются ВСЕ места — и снятые с продажи, и проходы (BLOCKED), —
   * а собственные переопределения места (цена, класс, доступность, подпись) переносятся
   * как есть: по ним мягкий патч потом пересчитывает наследование от сектора и ряда.
   * Возвращает число мест на продаже; стоячие секторы мест не имеют и считаются по вместимости.
   */
  private async materializeSeats(planId: number, eventId: number, groups: ProjectedGroup[]) {
    const [nodes, rows, drafts]: any[] = await Promise.all([
      SeatingPlanNode.find({ planId }).lean(),
      SeatingPlanRow.find({ planId }).lean(),
      SeatingPlanSeat.find({ planId }).lean(),
    ]);
    const sale = this.saleIndex(groups);
    const draftByKey = new Map<string, any>(drafts.map((seat: any) => [`${seat.rowId}:${seat.index}`, seat]));

    let onSale = 0;
    let batch: any[] = [];
    const flush = async () => {
      if (!batch.length) return;
      await SeatingPlanSeat.insertMany(batch);
      batch = [];
    };
    const push = async (doc: any, key: string) => {
      const group = sale.get(key);
      if (group) onSale += 1;
      batch.push({
        ...doc,
        eventId,
        salePrice: group ? group.price : null,
        saleCategory: group ? group.category : null,
        eventSectorId: group?.eventSectorId ?? null,
        eventZoneId: group?.eventZoneId ?? null,
        saleStatus: group ? SeatSaleStatus.FREE : SeatSaleStatus.BLOCKED,
      });
      if (batch.length >= BATCH) await flush();
    };

    // Черновые переопределения заменяются полными документами мест с теми же данными.
    await SeatingPlanSeat.deleteMany({ planId });

    const rowsBySector = this.byKey(rows, 'sectorId');
    const draftsBySector = this.byKey(drafts, 'sectorId');
    for (const sector of nodes.filter((node: any) => node.kind === NodeKind.SECTOR)) {
      for (const row of expandSector(sector, rowsBySector.get(sector.id) || [], draftsBySector.get(sector.id) || [])) {
        for (const seat of row.seats) {
          const own = draftByKey.get(`${seat.rowId}:${seat.index}`);
          await push(
            {
              planId,
              sectorId: sector.id,
              rowId: seat.rowId,
              objectId: null,
              index: seat.index,
              label: seat.label,
              seatType: own?.seatType ?? null,
              color: own?.color ?? null,
              ticket: own?.ticket ?? null,
              disabled: Boolean(own?.disabled),
            },
            `row:${seat.rowId}:${seat.index}`,
          );
        }
      }
    }

    for (const object of nodes.filter(isSellableObject)) {
      const places = objectPlaces(object);
      const base = objectLabel(object);
      for (let index = 0; index < places; index++) {
        await push(
          {
            planId,
            sectorId: object.parentId ?? null,
            rowId: null,
            objectId: object.id,
            index,
            label: places > 1 ? `${base} - Seat#${index + 1}` : base,
            seatType: object.objectType === ObjectType.ADD_SOFA ? 'sofa' : 'chair',
            color: object.color ?? null,
            ticket: null,
            disabled: false,
          },
          `object:${object.id}:${index}`,
        );
      }
    }

    await flush();
    return onSale + groups.reduce((sum, group) => sum + (group.standing ? group.seatsCount : 0), 0);
  }

  /** Место → его группа продажи: `row:<rowId>:<index>` или `object:<objectId>:<index>`. */
  private saleIndex(groups: ProjectedGroup[]) {
    const index = new Map<string, ProjectedGroup>();
    groups.forEach((group) =>
      group.seats.forEach((seat) =>
        index.set(
          seat.objectId != null ? `object:${seat.objectId}:${seat.index}` : `row:${seat.rowId}:${seat.index}`,
          group,
        ),
      ),
    );
    return index;
  }

  /**
   * Цена, класс, зона и доступность материализованных мест после мягкого патча. Место
   * находится по своему ключу (ряд + позиция или объект + позиция); проданное и
   * забронированное (SOLD/HELD) остаётся как было — меняются только FREE и BLOCKED.
   */
  private async relinkSeats(planId: number, groups: ProjectedGroup[]) {
    const sale = this.saleIndex(groups);
    const seats: any[] = await SeatingPlanSeat.find(
      { planId },
      { id: 1, rowId: 1, objectId: 1, index: 1, disabled: 1, saleStatus: 1 },
    ).lean();

    let ops: any[] = [];
    const flush = async () => {
      if (!ops.length) return;
      await SeatingPlanSeat.bulkWrite(ops, { ordered: false });
      ops = [];
    };

    for (const seat of seats) {
      const key = seat.objectId != null ? `object:${seat.objectId}:${seat.index}` : `row:${seat.rowId}:${seat.index}`;
      const group = sale.get(key);
      const $set: any = {
        salePrice: group ? group.price : null,
        saleCategory: group ? group.category : null,
        eventSectorId: group?.eventSectorId ?? null,
        eventZoneId: group?.eventZoneId ?? null,
      };
      if (!BUSY.includes(seat.saleStatus)) $set.saleStatus = group ? SeatSaleStatus.FREE : SeatSaleStatus.BLOCKED;
      ops.push({ updateOne: { filter: { id: seat.id }, update: { $set } } });
      if (ops.length >= BATCH) await flush();
    }
    await flush();
  }

  private async dropPlanTree(planId: number) {
    try {
      await Promise.all([
        SeatingPlanSeat.deleteMany({ planId }),
        SeatingPlanRow.deleteMany({ planId }),
        SeatingPlanNode.deleteMany({ planId }),
        SeatingPlanRoom.deleteMany({ planId }),
        SeatingPlan.deleteOne({ id: planId }),
      ]);
    } catch (error) {
      this.logger.error(`Failed to drop unpublished snapshot ${planId}: ${(error as Error)?.message}`);
    }
  }

  private byKey(items: any[], key: string) {
    return groupBy(items, key);
  }

  private async restoreNodes(nodes: any[]) {
    for (const node of nodes) {
      await SeatingPlanNode.updateOne(
        { id: node.id },
        { $set: { title: node.title, color: node.color, photo: node.photo ?? null, ticket: node.ticket } },
      );
    }
  }
}
