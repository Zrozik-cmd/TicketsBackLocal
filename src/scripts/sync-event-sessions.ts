/**
 * Re-materialises `event-sessions` for every event that has an enabled recurrence.
 *
 * Safe to re-run: `syncSessionsForEvent` upserts on `(eventId, date, start)`, keeps
 * flagless (legacy) disabled sessions disabled (only a `disabledBySchedule` one whose slot
 * is in the schedule comes back `active` — the app flags legacy rows at boot, see
 * `EventSessionsService.healLegacyDisabledSessions`; this script does not), and never
 * deletes a session that already has reservations or issued tickets.
 *
 *   npm run sync:event-sessions
 *
 * Booted standalone (plain `mongoose.connect` + `new EventSessionsService()`) rather
 * than through Nest: ts-node cannot resolve the full AppModule graph in this project.
 */
import 'reflect-metadata';
import * as dotenv from 'dotenv';
import mongoose from 'mongoose';
import { EventSchema, IEvent } from '../components/events/schemas/event.schema';
import { EventSessionsService } from '../components/event-sessions/event-sessions.service';

dotenv.config();

async function run(): Promise<void> {
  const uri = process.env.DATABASE_URL;
  if (!uri) {
    throw new Error('DATABASE_URL is not set');
  }

  await mongoose.connect(uri);
  console.log('Connected to MongoDB');

  const eventModel =
    (mongoose.models.Event as mongoose.Model<IEvent>) ??
    mongoose.model<IEvent>('Event', EventSchema);

  const service = new EventSessionsService();
  const events = (await eventModel
    .find({ 'recurrence.enabled': true })
    .select({ id: 1, recurrence: 1, title: 1 })
    .lean()
    .exec()) as Array<Pick<IEvent, 'id' | 'recurrence' | 'title'>>;

  console.log(`Found ${events.length} recurring event(s)`);

  let synced = 0;
  let failed = 0;
  for (const event of events) {
    try {
      const count = await service.syncSessionsForEvent(event.id, event.recurrence);
      synced += 1;
      console.log(
        `  event ${event.id} "${event.title?.en || event.title?.ru || event.title?.th || ''}" → ${count} session(s)`,
      );
    } catch (error) {
      failed += 1;
      console.error(`  event ${event.id} FAILED: ${(error as Error)?.message}`);
    }
  }

  console.log(`Done. synced=${synced}, failed=${failed}`);
  await mongoose.disconnect();
}

run().catch((error) => {
  console.error('sync:event-sessions failed', error);
  process.exit(1);
});
