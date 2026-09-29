import { Schema, Document } from 'mongoose';
import { autoIncrement } from 'mongoose-plugin-autoinc';

/**
 * Инкассатор — человек, которому кассир сдаёт наличные. Справочник ведёт
 * админ; инкассации хранят имя снимком, поэтому запись можно удалять без
 * потери истории.
 */
export interface ICashCollector extends Document {
  id: number;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

export const CashCollectorSchema = new Schema<ICashCollector>(
  {
    id: { type: Number, unique: true },
    name: { type: String, required: true, trim: true, unique: true },
  },
  { timestamps: true },
);

CashCollectorSchema.plugin(autoIncrement, { model: 'CashCollector', field: 'id', startAt: 1 });
