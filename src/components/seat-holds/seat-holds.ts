import { BadRequestException, ConflictException } from "@nestjs/common";
import mongoose from "mongoose";
import { EventSchema, type IEvent } from "../events/schemas/event.schema";
import {
  MockOrderSchema,
  type IMockOrder,
} from "../mock-orders/schemas/mock-order.schema";
import { TicketSchema, type ITicket } from "../tickets/schemas/ticket.schema";
import { HOLDS_SEAT_ORDER_STATUSES } from "../mock-orders/constants/order-status-sets.constant";
import { seatingPlanSeatModel } from "../seating-plan/schemas/seating-plan-seat.schema";
import { SEAT_HOLD_ERRORS as ERR } from "./constants/seat-holds.constants";
import {
  checkOrderSeats,
  type LineSeats,
  type OrderLineSeatsInput,
} from "./utils/seat-holds.util";

/**
 * Закрепление мест схемы зала за заказом. Место держит заказ, id которого записан в
 * `SeatingPlanSeat.orderId`, пока заказ жив (HOLDS_SEAT_ORDER_STATUSES), а у оплаченного —
 * пока жив билет на это место. Поэтому истёкший, отменённый, возвращённый заказ или
 * удалённый билет освобождают место сами, без отдельной записи; новый заказ просто
 * перезаписывает `orderId` условной записью (compare-and-set), и из двух покупателей
 * одного места выигрывает один.
 *
 * Модуль-лист: без Nest-зависимостей, данные через model getters (как event-messengers).
 */

const Seat = () => seatingPlanSeatModel();
const Event = () =>
  (mongoose.models.Event as mongoose.Model<IEvent>) ??
  mongoose.model<IEvent>("Event", EventSchema);
const Order = () =>
  (mongoose.models.MockOrder as mongoose.Model<IMockOrder>) ??
  mongoose.model<IMockOrder>("MockOrder", MockOrderSchema);
const TicketModel = () =>
  (mongoose.models.Ticket as mongoose.Model<ITicket>) ??
  mongoose.model<ITicket>("Ticket", TicketSchema);

export type SeatState = "HELD" | "SOLD";

/** Занятые места: HELD — держит неоплаченный заказ, SOLD — оплаченный, и билет на место жив. */
export async function takenSeats(
  seats: { id: number; orderId?: number | null }[],
): Promise<Map<number, SeatState>> {
  const held = seats.filter((seat) => seat.orderId != null);
  const taken = new Map<number, SeatState>();
  if (!held.length) return taken;

  const orders = await Order()
    .find({
      id: { $in: [...new Set(held.map((seat) => Number(seat.orderId)))] },
    })
    .select({ id: 1, status: 1 })
    .lean();
  const statusOf = new Map(
    orders.map((order) => [order.id, order.status as string]),
  );
  const paid = held.filter(
    (seat) => statusOf.get(Number(seat.orderId)) === "paid",
  );
  const tickets = paid.length
    ? await TicketModel()
        .find({
          orderId: { $in: paid.map((seat) => Number(seat.orderId)) },
          seatId: { $in: paid.map((seat) => seat.id) },
        })
        .select({ seatId: 1, orderId: 1 })
        .lean()
    : [];
  const sold = new Set(
    tickets.map((ticket: any) => `${ticket.orderId}:${ticket.seatId}`),
  );

  held.forEach((seat) => {
    const status = statusOf.get(Number(seat.orderId));
    if (!status || !HOLDS_SEAT_ORDER_STATUSES.includes(status)) return;
    if (status !== "paid") taken.set(seat.id, "HELD");
    else if (sold.has(`${seat.orderId}:${seat.id}`)) taken.set(seat.id, "SOLD");
  });
  return taken;
}

/**
 * До записи заказа: места из строк — в схеме события, в своей зоне, в продаже и
 * свободны. Без мест в строках — null (обычный заказ по количеству).
 */
export async function prepareOrderSeats(
  eventId: number,
  lines: OrderLineSeatsInput[],
): Promise<LineSeats[] | null> {
  const ids = lines.flatMap((line) => line.seatIds ?? []);
  if (!ids.length) return null;

  const event = await Event()
    .findOne({ id: Number(eventId) })
    .select({ seatingPlanId: 1 })
    .lean();
  if (!event?.seatingPlanId)
    throw new BadRequestException(ERR.seatsNotAvailable);

  const seats = await Seat()
    .find({ planId: event.seatingPlanId, id: { $in: ids } })
    .select({ id: 1, label: 1, eventZoneId: 1, saleStatus: 1, orderId: 1 })
    .lean();
  const { error, lines: out } = checkOrderSeats(
    lines,
    new Map(seats.map((seat) => [seat.id, seat])),
  );
  if (error) throw new BadRequestException(error);

  const taken = await takenSeats(seats as any[]);
  if (taken.size)
    throw new ConflictException({
      statusCode: 409,
      message: ERR.seatTaken,
      seatIds: [...taken.keys()],
    });
  return out;
}

/**
 * Сразу после записи заказа: места — за ним. Каждое место меняет владельца, только если
 * его `orderId` не изменился с проверки (compare-and-set). Место увели между проверкой и
 * записью — свои захваты откатываются, заказ закрывается через onFail, ответ 409.
 */
export async function claimOrderSeats(
  orderId: number,
  prepared: LineSeats[] | null,
  onFail: () => Promise<unknown> = async () => undefined,
) {
  const ids = (prepared ?? []).flatMap((line) =>
    line.seats.map((seat) => seat.id),
  );
  if (!ids.length) return;

  const seats = await Seat()
    .find({ id: { $in: ids } })
    .select({ id: 1, orderId: 1 })
    .lean();
  const taken = await takenSeats(seats as any[]);
  const result = taken.size
    ? null
    : await Seat().bulkWrite(
        seats.map((seat) => ({
          updateOne: {
            filter: { id: seat.id, orderId: (seat as any).orderId ?? null },
            update: { $set: { orderId: Number(orderId), holdUntil: null } },
          },
        })),
      );
  // matchedCount, не modifiedCount: повторный захват своих же мест (продление брони) — не конфликт
  if (result && result.matchedCount === ids.length) return;

  await Seat().updateMany(
    { id: { $in: ids }, orderId: Number(orderId) },
    { $set: { orderId: null } },
  );
  await onFail().catch(() => undefined);
  throw new ConflictException({
    statusCode: 409,
    message: ERR.seatTaken,
    seatIds: taken.size ? [...taken.keys()] : ids,
  });
}
