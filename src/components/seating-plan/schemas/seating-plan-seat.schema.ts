import mongoose, { Schema } from 'mongoose';
import { autoIncrement } from 'mongoose-plugin-autoinc';
import { SeatSaleStatus } from '../constants/seating-plan.constants';
import type { TicketSettings } from '../utils/expand.util';

/**
 * Место. Двойной режим:
 * - в DRAFT/TEMPLATE документ существует только там, где что-то переопределено
 *   вручную — полная сетка считается на лету из рядов (шаблон на 50 000 мест весит
 *   десятки документов, а не 50 000);
 * - в PUBLISHED места материализуются полностью: продаже нужен документ с состоянием.
 */
export interface ISeatingPlanSeat {
  id: number;
  planId: number;
  /** Сектор места; у стула/дивана/стола вне секторов — null. */
  sectorId: number | null;
  /** Ряд места; у места объекта (стул, диван, стол) — null. */
  rowId: number | null;
  /** Объект, который даёт место (стул, диван, стол); у места в ряду — null. */
  objectId: number | null;
  /** Позиция в ряду (или место за столом) — ключ идентичности места. */
  index: number;
  label: string | null;
  seatType: string | null;
  color: string | null;
  ticket: TicketSettings | null;
  /** Дырка в ряду: проход, место не продаётся. */
  disabled: boolean;

  // Ниже заполняется только в PUBLISHED. `ticket` выше остаётся собственным переопределением
  // места (как в черновике), а итог наследования сектор → ряд → место лежит отдельно —
  // иначе правка цены сектора после публикации не дошла бы до мест без своей цены.
  eventId: number | null;
  /** Итоговая цена и класс места на продаже. */
  salePrice: number | null;
  saleCategory: string | null;
  /** Сектор и зона события, через которые это место продаётся (`plan-…`). */
  eventSectorId: string | null;
  eventZoneId: string | null;
  saleStatus: SeatSaleStatus;
  holdUntil: Date | null;
  /** Заказ, за которым закреплено место (seat-holds): держит, пока заказ жив. */
  orderId: number | null;
  ticketId: number | null;

  createdAt: Date;
  updatedAt: Date;
}

export const SeatingPlanSeatSchema = new Schema<ISeatingPlanSeat>(
  {
    id: { type: Number, unique: true },
    planId: { type: Number, required: true },
    sectorId: { type: Number, default: null },
    rowId: { type: Number, default: null },
    objectId: { type: Number, default: null },
    index: { type: Number, required: true },
    label: { type: String, default: null },
    seatType: { type: String, default: null },
    color: { type: String, default: null },
    ticket: { type: Object, default: null },
    disabled: { type: Boolean, default: false },

    eventId: { type: Number, default: null },
    salePrice: { type: Number, default: null },
    saleCategory: { type: String, default: null },
    eventSectorId: { type: String, default: null },
    eventZoneId: { type: String, default: null },
    saleStatus: {
      type: String,
      enum: Object.values(SeatSaleStatus),
      default: SeatSaleStatus.FREE,
    },
    holdUntil: { type: Date, default: null },
    orderId: { type: Number, default: null },
    ticketId: { type: Number, default: null },
  },
  { timestamps: true, collection: 'seating_plan_seats', minimize: false },
);

SeatingPlanSeatSchema.index({ rowId: 1, index: 1 });
SeatingPlanSeatSchema.index({ planId: 1, sectorId: 1 });
SeatingPlanSeatSchema.index({ planId: 1, objectId: 1 });
SeatingPlanSeatSchema.index({ eventId: 1, saleStatus: 1 });
SeatingPlanSeatSchema.index({ orderId: 1 });

SeatingPlanSeatSchema.plugin(autoIncrement, { model: 'SeatingPlanSeat', field: 'id', startAt: 1 });

export function seatingPlanSeatModel(): mongoose.Model<ISeatingPlanSeat> {
  return (
    (mongoose.models.SeatingPlanSeat as mongoose.Model<ISeatingPlanSeat>) ??
    mongoose.model<ISeatingPlanSeat>('SeatingPlanSeat', SeatingPlanSeatSchema)
  );
}
