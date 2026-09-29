import { ictWallClockToInstant } from '../../events/utils/sales-cutoff.util';

/*
 * Регулярное событие: заказ может держать билеты на несколько показов, а `price` у заказа
 * один. Доля показа (или набора показов) в `price` — Σ(price×count его строк) /
 * Σ(price×count всех строк); если все строки бесплатные — доля по count. Это правило
 * `periodShareExpr` статистики; здесь — строительные блоки агрегации для финансов
 * (продажи по показам в кабинете организатора и непрошедшие показы в балансе).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** `price × count` строки билетов; `path` — `$$line` внутри $reduce или `$tickets` после $unwind. */
export function ticketLineAmountExpr(path: string) {
  return { $multiply: [{ $ifNull: [`${path}.price`, 0] }, { $ifNull: [`${path}.count`, 0] }] };
}

export function ticketLineCountExpr(path: string) {
  return { $ifNull: [`${path}.count`, 0] };
}

/** Σ `value` по строкам билетов заказа (строка доступна как `$$line`). */
export function sumTicketLinesExpr(value: unknown) {
  return {
    $reduce: {
      input: { $ifNull: ['$tickets', []] },
      initialValue: 0,
      in: { $let: { vars: { line: '$$this' }, in: { $add: ['$$value', value] } } },
    },
  };
}

/** Доля части заказа в его `price` (по сумме строк, при бесплатных строках — по count). */
export function priceShareExpr(partAmount: unknown, partCount: unknown, totalAmount: unknown, totalCount: unknown) {
  return {
    $cond: [
      { $gt: [totalAmount, 0] },
      { $divide: [partAmount, totalAmount] },
      { $cond: [{ $gt: [totalCount, 0] }, { $divide: [partCount, totalCount] }, 0] },
    ],
  };
}

/**
 * Стадии агрегации после $match заказов: доля `price` каждого заказа, приходящаяся на
 * показы `sessionIds`, сложенная по событию × «наличные или нет» (наличные — ещё и списком по заказам). Строки показов отбирает
 * $match после $unwind: `$in` запроса ищет по множеству, а `$in` выражения внутри $reduce
 * перебирал бы весь список показов на каждой строке (секунды на годовом расписании).
 */
export function showsPriceShareStages(sessionIds: number[]) {
  const sharePrice = { $multiply: ['$price', priceShareExpr('$partAmount', '$partCount', '$totalAmount', '$totalCount')] };
  return [
    {
      $project: {
        id: 1,
        event: 1,
        tickets: 1,
        cash: { $eq: ['$paymentMethod', 'CASH'] },
        price: { $ifNull: ['$price', 0] },
        totalAmount: sumTicketLinesExpr(ticketLineAmountExpr('$$line')),
        totalCount: sumTicketLinesExpr(ticketLineCountExpr('$$line')),
      },
    },
    { $unwind: '$tickets' },
    { $match: { 'tickets.session': { $in: sessionIds } } },
    {
      $group: {
        _id: '$_id',
        orderId: { $first: '$id' },
        event: { $first: '$event' },
        cash: { $first: '$cash' },
        price: { $first: '$price' },
        totalAmount: { $first: '$totalAmount' },
        totalCount: { $first: '$totalCount' },
        partAmount: { $sum: ticketLineAmountExpr('$tickets') },
        partCount: { $sum: ticketLineCountExpr('$tickets') },
      },
    },
    {
      $group: {
        _id: { event: '$event', cash: '$cash' },
        price: { $sum: sharePrice },
        // Only cash orders are listed one by one (the balance needs their share next to their money in the till).
        cashOrders: { $push: { $cond: ['$cash', { orderId: '$orderId', price: sharePrice }, '$$REMOVE'] } },
      },
    },
  ];
}

export type FinanceShowInfo = { id: number; date: string; start: string; end: string; status: string };

/**
 * Показ прошёл: он не отменён и уже закончился (ICT). Конец раньше начала — показ через
 * полночь, заканчивается на следующий день. Непонятная дата — не прошёл (деньги
 * заморожены, а не выданы по ошибке).
 */
export function isShowOver(show: FinanceShowInfo, now: number): boolean {
  if (show.status === 'cancelled') return false;
  const startAt = ictWallClockToInstant(show.date, show.start);
  let endAt = ictWallClockToInstant(show.date, show.end);
  if (!Number.isFinite(endAt)) return false;
  if (Number.isFinite(startAt) && endAt <= startAt) endAt += DAY_MS;
  return endAt <= now;
}
