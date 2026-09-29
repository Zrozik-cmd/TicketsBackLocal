import { Schema, Document } from "mongoose";
import { autoIncrement } from "mongoose-plugin-autoinc";

export interface IAdmin extends Document {
  id: number;
  email: string;
  /** Present when querying with `.select('+passwordHash')`. */
  passwordHash?: string;
  createdAt: Date;
  updatedAt: Date;
}

export const AdminSchema = new Schema<IAdmin>(
  {
    id: { type: Number, unique: true },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      unique: true,
    },
    passwordHash: { type: String, required: true, select: false },
  },
  { timestamps: true },
);

AdminSchema.plugin(autoIncrement, { model: "Admin", field: "id", startAt: 1 });
