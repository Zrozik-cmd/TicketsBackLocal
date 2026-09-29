import mongoose, { Schema } from 'mongoose';
import { autoIncrement } from 'mongoose-plugin-autoinc';
import type { Geometry } from '../utils/geometry.util';
import type { Numbering } from '../utils/numbering.util';
import type { TicketSettings } from '../utils/expand.util';

/**
 * Ряд сектора. Ряды всегда соответствуют `rowsCount` сектора и перегенерируются
 * при его правке; ключ идентичности — `index`, поэтому ручные правки ряда
 * переживают перегенерацию и переименование.
 */
export interface ISeatingPlanRow {
  id: number;
  planId: number;
  roomId: number;
  sectorId: number;
  index: number;
  label: string;
  seatsCount: number;
  /** `null` — наследуем от сектора. */
  seatType: string | null;
  color: string | null;
  ticket: TicketSettings | null;
  numbering: Numbering | null;
  geometry: Geometry | null;
  createdAt: Date;
  updatedAt: Date;
}

export const SeatingPlanRowSchema = new Schema<ISeatingPlanRow>(
  {
    id: { type: Number, unique: true },
    planId: { type: Number, required: true },
    roomId: { type: Number },
    sectorId: { type: Number, required: true },
    index: { type: Number, required: true },
    label: { type: String, default: '' },
    seatsCount: { type: Number, default: 0 },
    seatType: { type: String, default: null },
    color: { type: String, default: null },
    ticket: { type: Object, default: null },
    numbering: { type: Object, default: null },
    geometry: { type: Object, default: null },
  },
  { timestamps: true, collection: 'seating_plan_rows', minimize: false },
);

SeatingPlanRowSchema.index({ sectorId: 1, index: 1 });
SeatingPlanRowSchema.index({ planId: 1 });

SeatingPlanRowSchema.plugin(autoIncrement, { model: 'SeatingPlanRow', field: 'id', startAt: 1 });

export function seatingPlanRowModel(): mongoose.Model<ISeatingPlanRow> {
  return (
    (mongoose.models.SeatingPlanRow as mongoose.Model<ISeatingPlanRow>) ??
    mongoose.model<ISeatingPlanRow>('SeatingPlanRow', SeatingPlanRowSchema)
  );
}
