import mongoose from 'mongoose';
import { EventSchema, type IEvent } from '../events/schemas/event.schema';

const Event = () => (mongoose.models.Event as mongoose.Model<IEvent>) ?? mongoose.model<IEvent>('Event', EventSchema);

/** Секторы события как они лежат в базе (без счётчиков продаж), для keepPlanSectors. */
export async function currentEventSectors(eventId: number): Promise<any[]> {
  if (!Number.isFinite(eventId)) return [];
  const event = await Event().findOne({ id: eventId }).select({ sectors: 1 }).lean();
  return (event?.sectors as any[]) ?? [];
}
