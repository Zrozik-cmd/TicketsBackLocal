import mongoose, { Schema } from 'mongoose';
import { autoIncrement } from 'mongoose-plugin-autoinc';

/**
 * Холст (комната) проекта. Модалка Add Room переименовывает основной холст и
 * заводит следующий; количество не ограничено («две и больше сцен»).
 */
export interface ISeatingPlanRoom {
  id: number;
  planId: number;
  title: string;
  order: number;
  isMain: boolean;
  /** `{width, height, zoom, offsetX, offsetY}` — состояние холста конструктора. */
  canvas: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export const SeatingPlanRoomSchema = new Schema<ISeatingPlanRoom>(
  {
    id: { type: Number, unique: true },
    planId: { type: Number, required: true },
    title: { type: String, default: '' },
    order: { type: Number, default: 0 },
    isMain: { type: Boolean, default: false },
    canvas: { type: Object, default: {} },
  },
  { timestamps: true, collection: 'seating_plan_rooms', minimize: false },
);

SeatingPlanRoomSchema.index({ planId: 1, order: 1 });

SeatingPlanRoomSchema.plugin(autoIncrement, { model: 'SeatingPlanRoom', field: 'id', startAt: 1 });

export function seatingPlanRoomModel(): mongoose.Model<ISeatingPlanRoom> {
  return (
    (mongoose.models.SeatingPlanRoom as mongoose.Model<ISeatingPlanRoom>) ??
    mongoose.model<ISeatingPlanRoom>('SeatingPlanRoom', SeatingPlanRoomSchema)
  );
}
