import { eventArbiPayStoreModel, type EventArbiPayStoreStatus } from './schemas/event-arbipay-store.schema';

/*
 * Точки ARBI Pay при удалении события. Если у события есть точка, событие не удаляется
 * физически, а помечается `softDeleted` (events/event-soft-delete.ts): за кодом точки в
 * кабинете ARBI Pay должно оставаться событие, которое админ может открыть.
 * `pending` тоже считается: исход запроса на создание неизвестен, точка могла появиться.
 * `conflict` / `failed` — точки этого события в ARBI Pay нет.
 * Обычные функции, не сервис: их зовут AdminEventsService, AdminVaultEventsService и
 * EventRemovalService (модули админки и событий не импортируют ArbiPayStoresModule ради этого).
 */
const STORE_KEEPS_EVENT: EventArbiPayStoreStatus[] = ['active', 'pending'];

/** Сколько точек (active/pending) у события, на любом сервере платежей. */
export function countEventArbiPayStores(eventId: number): Promise<number> {
  return eventArbiPayStoreModel()
    .countDocuments({ eventId, status: { $in: STORE_KEEPS_EVENT } })
    .exec();
}

/** То же для многих событий сразу: eventId → число точек (событий без точек в карте нет). */
export async function countArbiPayStoresByEvent(eventIds: number[]): Promise<Map<number, number>> {
  if (!eventIds.length) return new Map();
  const rows = await eventArbiPayStoreModel()
    .aggregate<{ _id: number; n: number }>([
      { $match: { eventId: { $in: eventIds }, status: { $in: STORE_KEEPS_EVENT } } },
      { $group: { _id: '$eventId', n: { $sum: 1 } } },
    ])
    .exec();
  return new Map(rows.map((row) => [Number(row._id), row.n]));
}
