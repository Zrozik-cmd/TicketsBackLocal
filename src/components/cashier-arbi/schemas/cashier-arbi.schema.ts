import { Schema, Document } from 'mongoose';
import { autoIncrement } from 'mongoose-plugin-autoinc';

export const CASHIER_ARBI_ROLE = 'CashierArbi' as const;

export interface ICashierArbi extends Document {
  id: number;
  email: string;
  password?: string;
  passwordHash?: string;
  posLocation: string;
  posLocationUniqueId?: string;
  /** Деактивированный кассир не логинится и не подтверждает заказы; статистика остаётся. */
  isActive?: boolean;
  role: typeof CASHIER_ARBI_ROLE;
  createdAt: Date;
  updatedAt: Date;
}

export const CashierArbiSchema = new Schema<ICashierArbi>(
  {
    id: { type: Number, unique: true },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      unique: true,
    },
    password: { type: String, required: true, select: false },
    passwordHash: { type: String, required: true, select: false },
    posLocation: { type: String, required: true, trim: true },
    posLocationUniqueId: { type: String, required: false, trim: true },
    isActive: { type: Boolean, default: true },
    role: { type: String, required: true, enum: [CASHIER_ARBI_ROLE], default: CASHIER_ARBI_ROLE },
  },
  { timestamps: true },
);

CashierArbiSchema.plugin(autoIncrement, { model: 'CashierArbi', field: 'id', startAt: 1 });
