import { Schema, Document } from 'mongoose';
import { autoIncrement } from 'mongoose-plugin-autoinc';

export interface IMedia extends Document {
  id: number;
  file: Buffer;
  mimeType: string;
  user: number;
  /**
   * Файл не отдаётся публичным GET /media/:id.
   *
   * Обычные медиа — обложки и планы залов — публичны по замыслу. Но сюда же
   * складываются документы организаторов (выписка DBD), а id идут подряд:
   * без этого признака их можно было бы просто перебрать.
   */
  isPrivate?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export const MediaSchema = new Schema<IMedia>(
  {
    id: { type: Number, unique: true },
    file: { type: Buffer, required: true },
    mimeType: { type: String, required: true },
    user: { type: Number, required: true },
    isPrivate: { type: Boolean, default: false },
  },
  { timestamps: true },
);

MediaSchema.plugin(autoIncrement, { model: 'Media', field: 'id', startAt: 1 });
