import { Injectable, NotFoundException } from '@nestjs/common';
import mongoose from 'mongoose';
import { EventSchema, type IEvent } from '../../events/schemas/event.schema';
import { isHiddenFromSite } from '../../events/constants/event-visibility.constant';
import { takenSeats } from '../../seat-holds/seat-holds';
import { seatingPlanModel } from '../schemas/seating-plan.schema';
import { seatingPlanNodeModel } from '../schemas/seating-plan-node.schema';
import { seatingPlanRoomModel } from '../schemas/seating-plan-room.schema';
import { seatingPlanRowModel } from '../schemas/seating-plan-row.schema';
import { seatingPlanSeatModel } from '../schemas/seating-plan-seat.schema';
import { groupBy } from '../utils/plan-check.util';
import {
  NodeKind,
  SEATING_PLAN_ERRORS as ERR,
  SeatingPlanStatus,
  SeatSaleStatus,
} from '../constants/seating-plan.constants';

const SeatingPlan = seatingPlanModel();
const SeatingPlanNode = seatingPlanNodeModel();
const SeatingPlanRoom = seatingPlanRoomModel();
const SeatingPlanRow = seatingPlanRowModel();
const SeatingPlanSeat = seatingPlanSeatModel();

/**
 * Опубликованная схема события для витрины (окно выбора мест). Вынесено из сервиса
 * публикации: чтение схемы с занятостью мест — своя задача.
 */
@Injectable()
export class SeatingPlanMapService {
  private get eventModel(): mongoose.Model<IEvent> {
    return (mongoose.models.Event as mongoose.Model<IEvent>) ?? mongoose.model<IEvent>('Event', EventSchema);
  }

  /**
   * Опубликованная схема для страницы события: комнаты → узлы → ряды → места со статусом
   * продажи и зоной события, через которую место продаётся. Только чтение.
   */
  async BookingMap(eventId: number) {
    const event = await this.eventModel
      .findOne({ id: Number(eventId) })
      .select({ id: 1, softDeleted: 1, hiddenFromSite: 1, archivedByOrganizer: 1, seatingPlanId: 1 })
      .lean<Pick<IEvent, 'id' | 'softDeleted' | 'hiddenFromSite' | 'archivedByOrganizer' | 'seatingPlanId'>>()
      .exec();
    if (!event || event.softDeleted === true || isHiddenFromSite(event) || !event.seatingPlanId) {
      throw new NotFoundException(ERR.planNotFound);
    }

    const plan: any = await SeatingPlan.findOne({
      id: event.seatingPlanId,
      eventId: event.id,
      status: SeatingPlanStatus.PUBLISHED,
    }).lean();
    if (!plan) throw new NotFoundException(ERR.planNotFound);

    const [rooms, nodes, rows, seats]: any[] = await Promise.all([
      SeatingPlanRoom.find({ planId: plan.id }).sort({ order: 1 }).lean(),
      SeatingPlanNode.find({ planId: plan.id }).lean(),
      SeatingPlanRow.find({ planId: plan.id }).sort({ index: 1 }).lean(),
      SeatingPlanSeat.find({ planId: plan.id }).lean(),
    ]);
    // Занятость — по заказам, за которыми закреплены места (seat-holds): истёкшие и
    // отменённые заказы места не держат, записи для этого не нужны
    const taken = await takenSeats(seats);

    const seatsByRow = groupBy(seats, 'rowId');
    const seatsByObject = groupBy(seats.filter((seat: any) => seat.objectId != null), 'objectId');
    const seatView = (seat: any) => ({
      id: seat.id,
      index: seat.index,
      label: seat.label,
      seatType: seat.seatType,
      sectorId: seat.eventSectorId,
      zoneId: seat.eventZoneId,
      price: seat.salePrice ?? null,
      category: seat.saleCategory ?? null,
      saleStatus: seat.saleStatus === SeatSaleStatus.BLOCKED ? SeatSaleStatus.BLOCKED : taken.get(seat.id) ?? SeatSaleStatus.FREE,
    });

    return {
      planId: plan.id,
      version: plan.version,
      currency: plan.currency,
      totals: plan.totals,
      rooms: rooms.map((room: any) => ({
        id: room.id,
        title: room.title,
        canvas: room.canvas,
        nodes: nodes
          .filter((node: any) => node.roomId === room.id)
          .map((node: any) => ({
            id: node.id,
            kind: node.kind,
            title: node.title,
            geometry: node.geometry,
            color: node.color,
            sectorType: node.sectorType,
            venueType: node.venueType,
            playgroundType: node.playgroundType,
            objectType: node.objectType,
            form: node.form,
            seatsTotal: node.seatsTotal,
            tableNumber: node.tableNumber ?? null,
            // Стоячий сектор рисуется по capacity; декор мест не даёт
            capacity: node.capacity,
            decor: node.decor === true,
            // Стоячий сектор продаётся количеством: строка заказа — sectorId + zoneId, без seatIds
            eventSectorId: node.eventSectorId ?? null,
            zoneId: node.eventZoneId ?? null,
            text: node.text,
            fontSize: node.fontSize,
            labelStyle: node.labelStyle,
            photo: node.photo ?? null,
            // У стула, дивана и стола — его собственные места с ценой и статусом
            seats:
              node.kind === NodeKind.OBJECT
                ? (seatsByObject.get(node.id) || []).sort((a: any, b: any) => a.index - b.index).map(seatView)
                : [],
            rows:
              node.kind !== NodeKind.SECTOR
                ? []
                : rows
                    .filter((row: any) => row.sectorId === node.id)
                    .map((row: any) => ({
                      id: row.id,
                      index: row.index,
                      label: row.label,
                      seats: (seatsByRow.get(row.id) || [])
                        .sort((a: any, b: any) => a.index - b.index)
                        .map(seatView),
                    })),
          })),
      })),
    };
  }
}
