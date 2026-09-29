import mongoose, { Schema } from 'mongoose';
import { autoIncrement } from 'mongoose-plugin-autoinc';
import { DEFAULT_PLAN_CURRENCY, SeatingPlanStatus } from '../constants/seating-plan.constants';

/** Денормализованные итоги проекта: Live Review читает их одним документом. */
export interface ISeatingPlanTotals {
  rooms?: number;
  sectors?: number;
  seats?: number;
  byCategory?: Record<string, number>;
  bySeatType?: Record<string, number>;
}

/**
 * Проект схемы зала — самостоятельная сущность организатора: шаблон переиспользуется
 * между событиями, а событие получает неизменяемый снапшот (`status: PUBLISHED`).
 * Один набор коллекций обслуживает и редактор, и продажу — различает их статус.
 */
export interface ISeatingPlan {
  id: number;
  title: string;
  status: SeatingPlanStatus;
  /** User.id организатора: владелец плана (у менеджера — создавший его организатор). */
  creator: number;
  /** Кто создал план: `user:<id>` или `manager:<id>`. */
  createdBy?: string | null;
  /** Заполнено только у PUBLISHED (и у архивных снапшотов). */
  eventId: number | null;
  /** Из какого шаблона склонирован / что опубликовано. */
  sourcePlanId: number | null;
  /** ++ на каждую публикацию. */
  version: number;
  currency: string;
  /** Media.id миниатюры схемы (опционально). */
  preview?: number | null;
  totals: ISeatingPlanTotals;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export const SeatingPlanSchema = new Schema<ISeatingPlan>(
  {
    id: { type: Number, unique: true },
    title: { type: String, default: '' },
    status: {
      type: String,
      enum: Object.values(SeatingPlanStatus),
      default: SeatingPlanStatus.DRAFT,
    },
    creator: { type: Number, required: true },
    createdBy: { type: String, default: null },
    eventId: { type: Number, default: null },
    sourcePlanId: { type: Number, default: null },
    version: { type: Number, default: 1 },
    currency: { type: String, default: DEFAULT_PLAN_CURRENCY },
    preview: { type: Number, default: null },
    totals: { type: Object, default: {} },
    publishedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'seating_plans', minimize: false },
);

// Список шаблонов без индекса читал бы всю коллекцию.
SeatingPlanSchema.index({ creator: 1, status: 1 });
SeatingPlanSchema.index({ eventId: 1, status: 1 });

SeatingPlanSchema.plugin(autoIncrement, { model: 'SeatingPlan', field: 'id', startAt: 1 });

export function seatingPlanModel(): mongoose.Model<ISeatingPlan> {
  return (
    (mongoose.models.SeatingPlan as mongoose.Model<ISeatingPlan>) ??
    mongoose.model<ISeatingPlan>('SeatingPlan', SeatingPlanSchema)
  );
}
