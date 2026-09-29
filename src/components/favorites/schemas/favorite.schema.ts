import { Schema, Document } from 'mongoose';
import { autoIncrement } from 'mongoose-plugin-autoinc';

/** A customer's saved event ("Избранное"). */
export interface IFavorite extends Document {
  id: number;
  customer: number;
  eventId: number;
  created: Date;
}

export const FavoriteSchema = new Schema<IFavorite>(
  {
    id: { type: Number, unique: true },
    customer: { type: Number, required: true, index: true },
    eventId: { type: Number, required: true, index: true },
    created: { type: Date, required: true, default: Date.now },
  },
  { timestamps: false },
);

/** Saving the same event twice is a no-op, not a duplicate row. */
FavoriteSchema.index({ customer: 1, eventId: 1 }, { unique: true });

FavoriteSchema.plugin(autoIncrement, { model: 'Favorite', field: 'id', startAt: 1 });
