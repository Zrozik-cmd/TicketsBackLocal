import type { CashFlowState } from '../types/finance.types';

/*
 * Наличные по событиям — ОЦЕНКА (spec §1.5).
 *
 * В журнале касс у инкассаций, корректировок и обнулений нет ни заказа, ни
 * события, поэтому точно разложить кассу по событиям нельзя. Приближение —
 * FIFO-проигрыш журнала отдельно по каждому cashierId: продажи кладут «лоты»
 * события, инкассация забирает самые старые лоты, возврат снимает лоты своего
 * события начиная с новых. Всё, что не удалось привязать, идёт в «без события»
 * (eventId null), и сумма «события + без события» ВСЕГДА равна точным общим
 * цифрам — это инвариант, его проверяет QA.
 *
 * Лоты помнят и заказ, поэтому проигрыш знает, сколько денег КАЖДОГО заказа ещё не
 * в сейфе (`heldByOrder`: в кассе + в несданной/неподтверждённой инкассации). Это
 * нужно балансу: деньги заказа в возврате или на непрошедший показ, которые ещё в
 * кассе, уже заморожены как «не в офисе», и замораживать их второй раз нельзя.
 *
 * Функция чистая: никаких обращений к БД, только входные массивы.
 */

export type FifoLedgerRow = {
  id: number;
  cashierId: number;
  type: string;
  /** Подписанная сумма строки журнала. */
  amount: number;
  /** createdAt, ms. */
  createdAt: number;
  orderId?: number | null;
};

export type FifoCashOrder = {
  id: number;
  eventId: number | null;
  paymentMethod?: string | null;
  cashierId?: number | null;
  /** paymentConfirmedAt ?? createdAt, ms. */
  soldAt: number;
  totalPrice: number;
  status: string;
  /** refund.completedAt, ms. */
  refundCompletedAt?: number | null;
};

export type FifoVaultReceipt = { ledgerEntryId: number; amount: number };
export type FifoVaultPayout = { eventId: number; amountThb: number };

export type FifoCashInput = {
  ledger: FifoLedgerRow[];
  /** CASH-заказы (paid/refunded) и все заказы, на которые ссылаются sale/refund строки. */
  orders: FifoCashOrder[];
  vaultReceipts: FifoVaultReceipt[];
  /** Завершённые выплаты из сейфа. */
  vaultPayouts: FifoVaultPayout[];
};

export type FifoEncashmentSplit = {
  ledgerEntryId: number;
  cashierId: number;
  createdAt: number;
  /** Сдано инкассатору (положительное для обычной строки). */
  amount: number;
  confirmed: boolean;
  parts: Array<{ eventId: number | null; amount: number }>;
};

export type FifoCashResult = {
  /** Точные общие цифры (не оценка). */
  overall: CashFlowState;
  byEvent: Map<number, CashFlowState>;
  unattributed: CashFlowState;
  writtenOff: { byEvent: Map<number, number>; unattributed: number };
  encashments: FifoEncashmentSplit[];
  /** Сколько денег заказа (THB) ещё не в сейфе: в кассе + в инкассации без квитанции. */
  heldByOrder: Map<number, number>;
};

type Key = number | null;
type Lot = { eventId: Key; orderId: number | null; remaining: number };
/** `orderParts` — та же инкассация по заказам (только деньги с известным заказом). */
type EncashmentState = { row: FifoLedgerRow; parts: Map<Key, number>; orderParts: Map<number, number> };
type OrderBucket = Map<number, number> | null;

type TimelineItem =
  | { time: number; group: 0 | 1; seq: number; kind: 'lot'; eventId: Key; orderId: number; amount: number }
  | { time: number; group: 0 | 1; seq: number; kind: 'row'; row: FifoLedgerRow; amount: number };

const addTo = (map: Map<Key, number>, key: Key, value: number) => {
  map.set(key, (map.get(key) ?? 0) + value);
};

/** Снимает `amount` с долей заказов события `key` в инкассации: сначала заказ `first`, затем остальные. */
const takeOrderParts = (
  orderParts: Map<number, number>,
  amount: number,
  first: number | null | undefined,
  belongs: (orderId: number) => boolean,
) => {
  let rest = amount;
  const ids = [...orderParts.keys()].filter(belongs).sort((a, b) => (a === first ? -1 : b === first ? 1 : b - a));
  for (const id of ids) {
    if (rest <= 0) break;
    const share = orderParts.get(id) ?? 0;
    const take = Math.min(share, rest);
    orderParts.set(id, share - take);
    rest -= take;
  }
};

const normalizeEventId = (value: unknown): Key => {
  const n = Number(value);
  return value != null && Number.isFinite(n) ? n : null;
};

export function replayCashFifo(input: FifoCashInput): FifoCashResult {
  const ordersById = new Map<number, FifoCashOrder>();
  const cashOrdersByCashier = new Map<number, FifoCashOrder[]>();
  for (const order of input.orders) {
    ordersById.set(order.id, order);
    if (order.paymentMethod === 'CASH' && order.cashierId != null) {
      const list = cashOrdersByCashier.get(order.cashierId) ?? [];
      list.push(order);
      cashOrdersByCashier.set(order.cashierId, list);
    }
  }
  for (const list of cashOrdersByCashier.values()) {
    list.sort((a, b) => a.soldAt - b.soldAt || a.id - b.id);
  }

  const rowsByCashier = new Map<number, FifoLedgerRow[]>();
  for (const row of input.ledger) {
    const list = rowsByCashier.get(row.cashierId) ?? [];
    list.push(row);
    rowsByCashier.set(row.cashierId, list);
  }

  const lotsTotal = new Map<Key, number>();
  const heldByOrder = new Map<number, number>();
  const deficitsTotal = new Map<Key, number>();
  const writtenOff = new Map<Key, number>();
  const encashments: EncashmentState[] = [];

  const eventOfOrder = (orderId: number | null | undefined): Key => {
    if (orderId == null) return null;
    return normalizeEventId(ordersById.get(orderId)?.eventId);
  };

  const cashierIds = [...rowsByCashier.keys()].sort((a, b) => a - b);
  for (const cashierId of cashierIds) {
    const rows = [...(rowsByCashier.get(cashierId) ?? [])].sort(
      (a, b) => a.createdAt - b.createdAt || a.id - b.id,
    );

    /* ---- Таймлайн: opening раскрывается в синтетические продажи ---- */
    const saleOrderIds = new Set<number>();
    for (const row of rows) {
      if (row.type === 'sale' && row.orderId != null) saleOrderIds.add(row.orderId);
    }
    const expanded = new Set<number>();
    const items: TimelineItem[] = [];
    for (const row of rows) {
      if (row.type !== 'opening') {
        items.push({ time: row.createdAt, group: 1, seq: row.id, kind: 'row', row, amount: row.amount });
        continue;
      }
      let expandedSum = 0;
      for (const order of cashOrdersByCashier.get(cashierId) ?? []) {
        if (saleOrderIds.has(order.id) || expanded.has(order.id)) continue;
        if (!(order.soldAt <= row.createdAt)) continue;
        const counted =
          order.status === 'paid' ||
          (order.status === 'refunded' &&
            order.refundCompletedAt != null &&
            order.refundCompletedAt > row.createdAt);
        if (!counted) continue;
        expanded.add(order.id);
        expandedSum += order.totalPrice;
        items.push({
          time: order.soldAt,
          group: 0,
          seq: order.id,
          kind: 'lot',
          eventId: normalizeEventId(order.eventId),
          orderId: order.id,
          amount: order.totalPrice,
        });
      }
      // Разница opening и раскрытых заказов — лот (или долг) без события.
      items.push({
        time: row.createdAt,
        group: 1,
        seq: row.id,
        kind: 'row',
        row,
        amount: row.amount - expandedSum,
      });
    }
    items.sort((a, b) => a.time - b.time || a.group - b.group || a.seq - b.seq);

    /* ---- Проигрыш ---- */
    let lots: Lot[] = [];
    const deficits = new Map<Key, number>();
    const tillEncashments: EncashmentState[] = [];
    /*
     * Долги «без события» и место, где записана их доля (часть инкассации или
     * списание). Такой долг возникает, только когда лотов в кассе уже нет, а приход
     * события сначала гасит его и забирает эту долю себе. Поэтому лоты и долг
     * «без события» в одной кассе не сосуществуют, и касса события не завышается.
     */
    const nullDebts: Array<{ amount: number; bucket: Map<Key, number>; orderBucket: OrderBucket }> = [];
    let nullDebtHead = 0;
    const addNullDebt = (amount: number, bucket: Map<Key, number>, orderBucket: OrderBucket = null) => {
      if (!(amount > 0)) return;
      addTo(bucket, null, amount);
      addTo(deficits, null, amount);
      nullDebts.push({ amount, bucket, orderBucket });
    };
    /** Гасит долги «без события» (старые первыми); приход события забирает их долю себе. Возвращает остаток. */
    const repayNullDebts = (amount: number, key: Key, orderId: number | null = null): number => {
      let rest = amount;
      while (rest > 0 && nullDebtHead < nullDebts.length) {
        const debt = nullDebts[nullDebtHead];
        const take = Math.min(debt.amount, rest);
        debt.amount -= take;
        rest -= take;
        if (key !== null && take > 0) {
          addTo(deficits, null, -take);
          addTo(debt.bucket, null, -take);
          addTo(debt.bucket, key, take);
          if (orderId != null && debt.orderBucket) addTo(debt.orderBucket, orderId, take);
        }
        if (debt.amount <= 0) nullDebtHead++;
      }
      return rest;
    };

    const compact = () => {
      lots = lots.filter((lot) => lot.remaining > 0);
    };

    /**
     * Приход: сначала гасит долг того же ключа, затем (приход события) долги
     * «без события», забирая их долю себе; остаток — новый лот.
     */
    const inflow = (key: Key, amount: number, orderId: number | null = null) => {
      if (!(amount > 0)) return;
      let rest = amount;
      const debt = deficits.get(key) ?? 0;
      if (debt > 0) {
        const take = Math.min(debt, rest);
        deficits.set(key, debt - take);
        rest -= take;
        if (key === null) repayNullDebts(take, null);
      }
      if (key !== null && rest > 0) rest = repayNullDebts(rest, key, orderId);
      if (rest > 0) lots.push({ eventId: key, orderId, remaining: rest });
    };

    /** Расход по FIFO (старые лоты первыми); возвращает непокрытый остаток. */
    const consumeFifo = (amount: number, onPart: (key: Key, part: number, orderId: number | null) => void): number => {
      let rest = amount;
      for (const lot of lots) {
        if (rest <= 0) break;
        if (lot.remaining <= 0) continue;
        const take = Math.min(lot.remaining, rest);
        lot.remaining -= take;
        rest -= take;
        onPart(lot.eventId, take, lot.orderId);
      }
      compact();
      return rest > 0 ? rest : 0;
    };

    /** Списание (reset, корректировка −, отрицательная разница opening). */
    const writeOff = (amount: number) => {
      if (!(amount > 0)) return;
      addNullDebt(consumeFifo(amount, (key, part) => addTo(writtenOff, key, part)), writtenOff);
    };

    const signed = (amount: number, key: Key, orderId: number | null = null) => {
      if (amount > 0) inflow(key, amount, orderId);
      else if (amount < 0) writeOff(-amount);
    };
    /** Часть инкассации: событие → parts, заказ (если известен) → orderParts. */
    const intoEncashment = (parts: Map<Key, number>, orderParts: Map<number, number>) =>
      (key: Key, part: number, orderId: number | null) => {
        addTo(parts, key, part);
        if (orderId != null) addTo(orderParts, orderId, part);
      };

    for (const item of items) {
      if (item.kind === 'lot') {
        signed(item.amount, item.eventId, item.orderId);
        continue;
      }
      const { row, amount } = item;
      switch (row.type) {
        case 'sale':
          if (amount > 0) inflow(eventOfOrder(row.orderId), amount, row.orderId ?? null);
          else if (amount < 0) writeOff(-amount);
          break;
        case 'encashment': {
          const parts = new Map<Key, number>();
          const orderParts = new Map<number, number>();
          const handed = -amount;
          if (handed > 0) {
            addNullDebt(consumeFifo(handed, intoEncashment(parts, orderParts)), parts, orderParts);
          } else if (handed < 0) {
            // Положительная «инкассация» (в данных не встречается): деньги вернулись в кассу.
            inflow(null, -handed);
            addTo(parts, null, handed);
          }
          const state = { row, parts, orderParts };
          tillEncashments.push(state);
          encashments.push(state);
          break;
        }
        case 'refund': {
          const key = eventOfOrder(row.orderId);
          if (amount > 0) {
            inflow(key, amount);
            break;
          }
          let rest = -amount;
          // 1) лоты своего события в этой кассе — сначала лот самого заказа, затем с новых
          const refundLots = lots.filter((lot) => lot.eventId === key && lot.remaining > 0).reverse();
          refundLots.sort((a, b) => Number(b.orderId === row.orderId) - Number(a.orderId === row.orderId));
          for (const lot of refundLots) {
            if (rest <= 0) break;
            const take = Math.min(lot.remaining, rest);
            lot.remaining -= take;
            rest -= take;
          }
          compact();
          // 2) деньги события уже сданы — уменьшаем его долю в инкассациях (новые первыми)
          if (key !== null) {
            for (let i = tillEncashments.length - 1; i >= 0 && rest > 0; i--) {
              const { parts, orderParts } = tillEncashments[i];
              const share = parts.get(key) ?? 0;
              if (share <= 0) continue;
              const take = Math.min(share, rest);
              parts.set(key, share - take);
              takeOrderParts(orderParts, take, row.orderId, (id) => eventOfOrder(id) === key);
              // возврат выдан из наличных, что ещё лежат в кассе (лотов события уже нет):
              // их события замещают долю в инкассации, непокрытое — долг «без события»
              addNullDebt(consumeFifo(take, intoEncashment(parts, orderParts)), parts, orderParts);
              rest -= take;
            }
          }
          // 3) и этого не хватило — отрицательная касса события (spec §1.5);
          //    возврат заказа без события расходует кассу, как списание
          if (rest > 0) {
            if (key !== null) addTo(deficits, key, rest);
            else writeOff(rest);
          }
          break;
        }
        default:
          // opening (разница), adjustment, reset и неизвестные типы — без события
          signed(amount, null);
      }
    }

    for (const lot of lots) {
      addTo(lotsTotal, lot.eventId, lot.remaining);
      if (lot.orderId != null) addTo(heldByOrder, lot.orderId, lot.remaining);
    }
    for (const [key, debt] of deficits) addTo(deficitsTotal, key, debt);
  }

  /* ---- Сборка результата ---- */
  const byEvent = new Map<number, CashFlowState>();
  const unattributed: CashFlowState = { atCashier: 0, inTransit: 0, inVault: 0 };
  const stateOf = (key: Key): CashFlowState => {
    if (key === null) return unattributed;
    let state = byEvent.get(key);
    if (!state) {
      state = { atCashier: 0, inTransit: 0, inVault: 0 };
      byEvent.set(key, state);
    }
    return state;
  };

  for (const [key, value] of lotsTotal) stateOf(key).atCashier += value;
  for (const [key, value] of deficitsTotal) stateOf(key).atCashier -= value;

  const receiptByLedgerId = new Map<number, number>();
  for (const receipt of input.vaultReceipts) {
    receiptByLedgerId.set(
      receipt.ledgerEntryId,
      (receiptByLedgerId.get(receipt.ledgerEntryId) ?? 0) + receipt.amount,
    );
  }

  const overall: CashFlowState = { atCashier: 0, inTransit: 0, inVault: 0 };
  for (const row of input.ledger) overall.atCashier += row.amount;

  const encashmentIds = new Set<number>();
  const splits: FifoEncashmentSplit[] = [];
  for (const { row, parts, orderParts } of encashments) {
    encashmentIds.add(row.id);
    const receiptAmount = receiptByLedgerId.get(row.id);
    const confirmed = receiptAmount !== undefined;
    if (!confirmed) for (const [orderId, part] of orderParts) if (part > 0) addTo(heldByOrder, orderId, part);
    for (const [key, part] of parts) {
      if (confirmed) stateOf(key).inVault += part;
      else stateOf(key).inTransit += part;
    }
    if (confirmed) {
      // Квитанция всегда = −amount строки; расхождение (если вдруг) — без события.
      unattributed.inVault += receiptAmount - -row.amount;
    } else {
      overall.inTransit += -row.amount;
    }
    splits.push({
      ledgerEntryId: row.id,
      cashierId: row.cashierId,
      createdAt: row.createdAt,
      amount: -row.amount,
      confirmed,
      parts: [...parts.entries()].map(([eventId, amount]) => ({ eventId, amount })),
    });
  }
  // Квитанции на строки, которых нет среди инкассаций, — в сейфе, но без события.
  for (const [ledgerEntryId, amount] of receiptByLedgerId) {
    overall.inVault += amount;
    if (!encashmentIds.has(ledgerEntryId)) unattributed.inVault += amount;
  }
  for (const payout of input.vaultPayouts) {
    overall.inVault -= payout.amountThb;
    stateOf(normalizeEventId(payout.eventId)).inVault -= payout.amountThb;
  }

  const writtenOffByEvent = new Map<number, number>();
  let writtenOffUnattributed = 0;
  for (const [key, value] of writtenOff) {
    if (key === null) writtenOffUnattributed += value;
    else writtenOffByEvent.set(key, value);
  }

  splits.sort((a, b) => a.createdAt - b.createdAt || a.ledgerEntryId - b.ledgerEntryId);
  return {
    overall,
    byEvent,
    unattributed,
    writtenOff: { byEvent: writtenOffByEvent, unattributed: writtenOffUnattributed },
    encashments: splits,
    heldByOrder,
  };
}
