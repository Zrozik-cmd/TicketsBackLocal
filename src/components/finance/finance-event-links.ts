import { organizerPayoutModel } from './schemas/organizer-payout.schema';

/*
 * Финансы события при его удалении (CLAUDE.md, инвариант F). Выплата организатору —
 * финансовая запись, поэтому событие с выплатами (любого статуса, в т.ч. аванс до продаж)
 * не удаляется: в админке это блокер `has_payouts`, у организатора — причина перенести
 * событие в архив. Иначе выплата осталась бы без события: борд показал бы её строкой
 * «#id» без организатора, а организатор получил бы 404.
 *
 * Обычные функции, не сервис: их зовут AdminEventsService, AdminVaultEventsService и
 * EventRemovalService, которым нельзя импортировать FinanceModule (как event-messengers.cleanup).
 * Точки ARBI Pay (`eventarbipaystores`) удалению не мешают и остаются: код точки в ARBI Pay
 * занят навсегда, а id событий не переиспользуются.
 */

/** Сколько выплат (любого статуса) записано на событие. */
export function countEventPayouts(eventId: number): Promise<number> {
  return organizerPayoutModel().countDocuments({ eventId }).exec();
}

/** То же для многих событий сразу: eventId → число выплат (событий без выплат в карте нет). */
export async function countPayoutsByEvent(eventIds: number[]): Promise<Map<number, number>> {
  if (!eventIds.length) return new Map();
  const rows = await organizerPayoutModel()
    .aggregate<{ _id: number; n: number }>([
      { $match: { eventId: { $in: eventIds } } },
      { $group: { _id: '$eventId', n: { $sum: 1 } } },
    ])
    .exec();
  return new Map(rows.map((row) => [Number(row._id), row.n]));
}
