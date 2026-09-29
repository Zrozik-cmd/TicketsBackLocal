import mongoose from 'mongoose';
import { AdminSchema, IAdmin } from '../admin/schemas/admin.schema';
import {
  CashLedgerEntrySchema,
  ICashLedgerEntry,
} from '../cash-encashments/schemas/cash-ledger-entry.schema';
import { EventSchema, IEvent } from '../events/schemas/event.schema';
import { EventSessionSchema, IEventSession } from '../event-sessions/schemas/event-session.schema';
import { IMockOrder, MockOrderSchema } from '../mock-orders/schemas/mock-order.schema';
import { IUser, UserSchema } from '../users/schemas/user.schema';

/*
 * Чужие коллекции, которые финансы только ЧИТАЮТ. Ленивые геттеры, как везде в
 * проекте (без @nestjs/mongoose): модель регистрируется при первом обращении.
 */

export function financeEventModel(): mongoose.Model<IEvent> {
  return (mongoose.models.Event as mongoose.Model<IEvent>) ?? mongoose.model<IEvent>('Event', EventSchema);
}

export function financeUserModel(): mongoose.Model<IUser> {
  return (mongoose.models.User as mongoose.Model<IUser>) ?? mongoose.model<IUser>('User', UserSchema);
}

export function financeMockOrderModel(): mongoose.Model<IMockOrder> {
  return (
    (mongoose.models.MockOrder as mongoose.Model<IMockOrder>) ??
    mongoose.model<IMockOrder>('MockOrder', MockOrderSchema)
  );
}

export function financeAdminModel(): mongoose.Model<IAdmin> {
  return (mongoose.models.Admin as mongoose.Model<IAdmin>) ?? mongoose.model<IAdmin>('Admin', AdminSchema);
}

export function financeCashLedgerModel(): mongoose.Model<ICashLedgerEntry> {
  return (
    (mongoose.models.CashLedgerEntry as mongoose.Model<ICashLedgerEntry>) ??
    mongoose.model<ICashLedgerEntry>('CashLedgerEntry', CashLedgerEntrySchema)
  );
}

export function financeEventSessionModel(): mongoose.Model<IEventSession> {
  return (
    (mongoose.models.EventSession as mongoose.Model<IEventSession>) ??
    mongoose.model<IEventSession>('EventSession', EventSessionSchema)
  );
}
