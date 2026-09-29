import mongoose, { Schema } from 'mongoose';
import { autoIncrement } from 'mongoose-plugin-autoinc';
import type { NormalizedGeometry } from '../utils/geometry.util';
import type { Numbering } from '../utils/numbering.util';
import type { TicketSettings } from '../utils/expand.util';

/**
 * Всё, что лежит на холсте: сектор, площадка (сцена, корт…) и объект интерьера.
 * Полиморфная коллекция, различает их `kind`. «Clean sector» из Additional objects —
 * это объект `clean_sector`, мест он не даёт.
 */
export interface ISeatingPlanNode {
  id: number;
  planId: number;
  roomId: number;
  kind: string;
  /** Сектор-контейнер: объект, чей центр внутри границ сектора, считается его частью. */
  parentId: number | null;
  title: string;
  /** `{x, y, width, height, rotation, zIndex}` в координатах холста. */
  geometry: NormalizedGeometry;
  color: string | null;
  locked: boolean;

  // kind = venue
  venueType?: string;
  playgroundType?: string;
  form?: string;

  // kind = sector
  sectorType?: string;
  rowsCount: number;
  seatsPerRow: number;
  /** Вместимость стоячего сектора и номерного стола. */
  capacity: number;
  seatType?: string;
  numbering: Numbering;
  ticket: TicketSettings;
  /** Media.id фото сектора (Live Review, Photo_card). */
  photo?: number | null;
  /** Денормализовано: места рядов плюс вложенные продаваемые объекты. */
  seatsTotal: number;
  /** Стоячий сектор опубликованного снапшота: сектор и зона события, где он продаётся. */
  eventSectorId?: string | null;
  eventZoneId?: string | null;

  // kind = object
  objectType?: string;
  isSellable: boolean;
  /** Декор: рисуется, но мест не даёт и не продаётся (см. `isSellableObject`). */
  decor: boolean;
  /** Номер банкетного стола (`numbered_table`). */
  tableNumber?: number | null;
  /** Подпись (`text_label`): текст (строки через `\n`), кегль и вид plain/badge. */
  text?: string;
  fontSize?: number;
  labelStyle?: string;

  createdAt: Date;
  updatedAt: Date;
}

export const SeatingPlanNodeSchema = new Schema<ISeatingPlanNode>(
  {
    id: { type: Number, unique: true },
    planId: { type: Number, required: true },
    roomId: { type: Number, required: true },
    kind: { type: String, required: true },
    parentId: { type: Number, default: null },
    title: { type: String, default: '' },
    geometry: { type: Object, default: {} },
    color: { type: String, default: null },
    locked: { type: Boolean, default: false },

    venueType: { type: String },
    playgroundType: { type: String },
    form: { type: String },

    sectorType: { type: String },
    rowsCount: { type: Number, default: 0 },
    seatsPerRow: { type: Number, default: 0 },
    capacity: { type: Number, default: 0 },
    seatType: { type: String },
    numbering: { type: Object, default: {} },
    ticket: { type: Object, default: {} },
    photo: { type: Number, default: null },
    seatsTotal: { type: Number, default: 0 },
    eventSectorId: { type: String, default: null },
    eventZoneId: { type: String, default: null },

    objectType: { type: String },
    isSellable: { type: Boolean, default: false },
    decor: { type: Boolean, default: false },
    tableNumber: { type: Number, default: null },
    text: { type: String },
    fontSize: { type: Number },
    labelStyle: { type: String },
  },
  { timestamps: true, collection: 'seating_plan_nodes', minimize: false },
);

SeatingPlanNodeSchema.index({ planId: 1, roomId: 1 });
SeatingPlanNodeSchema.index({ parentId: 1 });

SeatingPlanNodeSchema.plugin(autoIncrement, { model: 'SeatingPlanNode', field: 'id', startAt: 1 });

export function seatingPlanNodeModel(): mongoose.Model<ISeatingPlanNode> {
  return (
    (mongoose.models.SeatingPlanNode as mongoose.Model<ISeatingPlanNode>) ??
    mongoose.model<ISeatingPlanNode>('SeatingPlanNode', SeatingPlanNodeSchema)
  );
}
