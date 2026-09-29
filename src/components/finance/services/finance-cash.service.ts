import { BadRequestException, Injectable } from '@nestjs/common';
import { financeCashLedgerModel, financeMockOrderModel } from '../finance-models';
import { cashVaultReceiptModel } from '../schemas/cash-vault-receipt.schema';
import { organizerPayoutModel } from '../schemas/organizer-payout.schema';
import { CashFlowState, FinanceEncashment } from '../types/finance.types';
import {
  FifoCashOrder,
  FifoCashResult,
  FifoLedgerRow,
  replayCashFifo,
} from '../utils/finance-cash-fifo.util';
import { emptyCash, round2, roundCash, toIsoOrNull, toMs } from '../utils/finance-money.util';
import type { FinanceHeldCashOrder } from '../utils/finance-balances.util';
import { FinanceDirectoryService } from './finance-directory.service';

export const FINANCE_NOT_ENCASHMENT = 'finance_not_encashment';
export const FINANCE_VAULT_CONFIRM_MAX = 200;

/** Наличные: точные общие цифры + FIFO-оценка по событиям. Все суммы округлены. */
export type FinanceCashState = {
  /**
   * 'all' — проигрыш всего журнала. 'event' — только касс одного события
   * (computeEventCashState): byEvent и overall точные, unattributed и raw — частичные.
   */
  scope: 'all' | 'event';
  overall: CashFlowState;
  unattributed: CashFlowState;
  byEvent: Map<number, CashFlowState>;
  /** Наличные заказы, чьи деньги ещё не в сейфе (по событиям) — балансу, чтобы не заморозить их дважды. */
  heldOrdersByEvent: Map<number, FinanceHeldCashOrder[]>;
  /** Неокруглённый результат проигрыша — для сверок/QA. */
  raw: FifoCashResult;
};

type LeanLedgerRow = {
  id: number;
  cashierId: number;
  cashierEmail?: string;
  type: string;
  amount: number;
  orderId?: number | null;
  collectorName?: string;
  note?: string;
  createdAt: Date;
};

type LeanReceipt = { ledgerEntryId: number; amount: number };
type LeanVaultPayoutGroup = { _id: number; amountThb: number };

type LeanCashOrder = {
  id: number;
  event: number;
  paymentMethod?: string;
  cashierId?: number | null;
  total_price?: number;
  price?: number;
  status: string;
  refundStatus?: string | null;
  paymentConfirmedAt?: Date | null;
  createdAt?: Date | null;
  refund?: { completedAt?: Date | null } | null;
};

const ORDER_FIELDS =
  'id event paymentMethod cashierId total_price price status refundStatus paymentConfirmedAt createdAt refund.completedAt';
const LEDGER_FIELDS = 'id cashierId type amount orderId createdAt';
const CASH_ORDER_STATUSES = ['paid', 'refunded'];

@Injectable()
export class FinanceCashService {
  constructor(private readonly directory: FinanceDirectoryService) {}

  private get ledgerModel() {
    return financeCashLedgerModel();
  }

  private get orderModel() {
    return financeMockOrderModel();
  }

  private get receiptModel() {
    return cashVaultReceiptModel();
  }

  private get payoutModel() {
    return organizerPayoutModel();
  }

  /**
   * Состояние наличных (spec §1.5): весь журнал + CASH-заказы + квитанции сейфа +
   * выплаты из сейфа — четыре чтения, без запросов на строку.
   */
  async computeCashState(): Promise<FinanceCashState> {
    const [ledger, cashOrders, receipts, vaultPayouts] = await Promise.all([
      this.ledgerModel.find({}).select(LEDGER_FIELDS).lean<LeanLedgerRow[]>().exec(),
      this.orderModel
        .find({ paymentMethod: 'CASH', status: { $in: CASH_ORDER_STATUSES } })
        .select(ORDER_FIELDS)
        .lean<LeanCashOrder[]>()
        .exec(),
      this.receiptModel.find({}).select('ledgerEntryId amount').lean<LeanReceipt[]>().exec(),
      this.loadVaultPayouts(null),
    ]);

    const { raw, heldOrdersByEvent } = await this.replay(ledger, cashOrders, receipts, vaultPayouts);
    const byEvent = new Map<number, CashFlowState>();
    for (const [eventId, state] of raw.byEvent) byEvent.set(eventId, roundCash(state));
    return {
      scope: 'all',
      overall: roundCash(raw.overall),
      unattributed: roundCash(raw.unattributed),
      byEvent,
      heldOrdersByEvent,
      raw,
    };
  }

  /**
   * Наличные ОДНОГО события без чтения всей истории. FIFO идёт по каждой кассе
   * отдельно, а касса без sale/refund-строк заказов события и без его
   * CASH-заказов (раскрытие opening) не даёт событию ни лотов, ни долгов, ни долей
   * инкассаций. Поэтому проигрыш только касс события даёт для него ровно то же,
   * что полный computeCashState. byEvent — только это событие; overall — точные
   * агрегаты по всему журналу в БД; unattributed и raw — частичные (их читает
   * только доска, а она берёт полный проигрыш).
   */
  async computeEventCashState(eventId: number): Promise<FinanceCashState> {
    const eventOrders = await this.orderModel
      .find({ event: eventId })
      .select('id paymentMethod cashierId status')
      .lean<Array<Pick<LeanCashOrder, 'id' | 'paymentMethod' | 'cashierId' | 'status'>>>()
      .exec();
    const orderIds = eventOrders.map((order) => order.id);
    const [saleTills, refundTills] = orderIds.length
      ? await Promise.all([
          this.ledgerModel.distinct('cashierId', { type: 'sale', orderId: { $in: orderIds } }).exec(),
          this.ledgerModel.distinct('cashierId', { type: 'refund', orderId: { $in: orderIds } }).exec(),
        ])
      : [[], []];
    const tills = new Set<number>();
    // Ключ кассы — как в полном проигрыше: Number(cashierId) || 0.
    for (const value of [...saleTills, ...refundTills]) tills.add(Number(value) || 0);
    for (const order of eventOrders) {
      if (order.paymentMethod !== 'CASH' || order.cashierId == null) continue;
      if (!CASH_ORDER_STATUSES.includes(order.status)) continue;
      const cashierId = Number(order.cashierId);
      if (Number.isFinite(cashierId)) tills.add(cashierId);
    }
    const tillIds = [...tills];

    const [ledger, cashOrders, vaultPayouts, overall] = await Promise.all([
      tillIds.length
        ? this.ledgerModel.find({ cashierId: { $in: tillIds } }).select(LEDGER_FIELDS).lean<LeanLedgerRow[]>().exec()
        : Promise.resolve<LeanLedgerRow[]>([]),
      tillIds.length
        ? this.orderModel
            .find({ paymentMethod: 'CASH', status: { $in: CASH_ORDER_STATUSES }, cashierId: { $in: tillIds } })
            .select(ORDER_FIELDS)
            .lean<LeanCashOrder[]>()
            .exec()
        : Promise.resolve<LeanCashOrder[]>([]),
      this.loadVaultPayouts(eventId),
      this.computeOverallCash(),
    ]);
    const encashmentIds = ledger.filter((row) => row.type === 'encashment').map((row) => row.id);
    const receipts = encashmentIds.length
      ? await this.receiptModel
          .find({ ledgerEntryId: { $in: encashmentIds } })
          .select('ledgerEntryId amount')
          .lean<LeanReceipt[]>()
          .exec()
      : [];

    const { raw, heldOrdersByEvent } = await this.replay(ledger, cashOrders, receipts, vaultPayouts);
    const byEvent = new Map<number, CashFlowState>();
    const own = raw.byEvent.get(eventId);
    if (own) byEvent.set(eventId, roundCash(own));
    return {
      scope: 'event',
      overall: roundCash(overall),
      unattributed: roundCash(raw.unattributed),
      byEvent,
      heldOrdersByEvent,
      raw,
    };
  }

  /** Завершённые выплаты из сейфа по событиям (null — все события). */
  private loadVaultPayouts(eventId: number | null): Promise<LeanVaultPayoutGroup[]> {
    return this.payoutModel
      .aggregate<LeanVaultPayoutGroup>([
        { $match: { status: 'completed', source: 'vault', ...(eventId === null ? {} : { eventId }) } },
        { $group: { _id: '$eventId', amountThb: { $sum: '$amountThb' } } },
      ])
      .exec();
  }

  /** Точные общие цифры (spec §1.5) агрегатами в БД — то же, что overall полного проигрыша. */
  private async computeOverallCash(): Promise<CashFlowState> {
    const totalOf = (rows: Array<{ total?: number }>) => Number(rows[0]?.total) || 0;
    const [ledgerTotal, notConfirmedTotal, receiptsTotal, vaultPaidTotal] = await Promise.all([
      this.ledgerModel.aggregate<{ total: number }>([{ $group: { _id: null, total: { $sum: '$amount' } } }]).exec(),
      this.ledgerModel
        .aggregate<{ total: number }>([
          { $match: { type: 'encashment' } },
          {
            $lookup: {
              from: this.receiptModel.collection.collectionName,
              localField: 'id',
              foreignField: 'ledgerEntryId',
              as: 'receipt',
            },
          },
          { $match: { receipt: { $size: 0 } } },
          { $group: { _id: null, total: { $sum: '$amount' } } },
        ])
        .exec(),
      this.receiptModel.aggregate<{ total: number }>([{ $group: { _id: null, total: { $sum: '$amount' } } }]).exec(),
      this.payoutModel
        .aggregate<{ total: number }>([
          { $match: { status: 'completed', source: 'vault' } },
          { $group: { _id: null, total: { $sum: '$amountThb' } } },
        ])
        .exec(),
    ]);
    return {
      atCashier: totalOf(ledgerTotal),
      inTransit: -totalOf(notConfirmedTotal),
      inVault: totalOf(receiptsTotal) - totalOf(vaultPaidTotal),
    };
  }

  /** FIFO-проигрыш по прочитанным строкам (дочитывает заказы, на которые ссылаются sale/refund). */
  private async replay(
    ledger: LeanLedgerRow[],
    cashOrders: LeanCashOrder[],
    receipts: LeanReceipt[],
    vaultPayouts: LeanVaultPayoutGroup[],
  ): Promise<{ raw: FifoCashResult; heldOrdersByEvent: Map<number, FinanceHeldCashOrder[]> }> {
    // sale/refund могут ссылаться на заказ не из выборки выше (например, не CASH) — дочитываем разом.
    const known = new Set(cashOrders.map((order) => order.id));
    const missing = new Set<number>();
    for (const row of ledger) {
      if ((row.type === 'sale' || row.type === 'refund') && row.orderId != null && !known.has(row.orderId)) {
        missing.add(row.orderId);
      }
    }
    const extraOrders = missing.size
      ? await this.orderModel.find({ id: { $in: [...missing] } }).select(ORDER_FIELDS).lean<LeanCashOrder[]>().exec()
      : [];

    const toFifoOrder = (order: LeanCashOrder): FifoCashOrder => ({
      id: order.id,
      eventId: Number.isFinite(Number(order.event)) ? Number(order.event) : null,
      paymentMethod: order.paymentMethod ?? null,
      cashierId: order.cashierId ?? null,
      soldAt: toMs(order.paymentConfirmedAt) ?? toMs(order.createdAt) ?? 0,
      totalPrice: Number(order.total_price) || 0,
      status: order.status,
      refundCompletedAt: toMs(order.refund?.completedAt),
    });
    const fifoLedger: FifoLedgerRow[] = ledger.map((row) => ({
      id: row.id,
      cashierId: Number(row.cashierId) || 0,
      type: row.type,
      amount: Number(row.amount) || 0,
      createdAt: toMs(row.createdAt) ?? 0,
      orderId: row.orderId ?? null,
    }));

    const orders = [...cashOrders, ...extraOrders];
    const raw = replayCashFifo({
      ledger: fifoLedger,
      orders: orders.map(toFifoOrder),
      vaultReceipts: receipts.map((receipt) => ({
        ledgerEntryId: receipt.ledgerEntryId,
        amount: Number(receipt.amount) || 0,
      })),
      vaultPayouts: vaultPayouts.map((payout) => ({
        eventId: Number(payout._id),
        amountThb: Number(payout.amountThb) || 0,
      })),
    });
    return { raw, heldOrdersByEvent: FinanceCashService.groupHeldOrders(raw.heldByOrder, orders) };
  }

  /** Заказы с деньгами не в сейфе (больше полсатанга), по событиям. */
  private static groupHeldOrders(
    heldByOrder: Map<number, number>,
    orders: LeanCashOrder[],
  ): Map<number, FinanceHeldCashOrder[]> {
    const byId = new Map(orders.map((order) => [order.id, order]));
    const result = new Map<number, FinanceHeldCashOrder[]>();
    for (const [orderId, heldThb] of heldByOrder) {
      const order = byId.get(orderId);
      const eventId = Number(order?.event);
      if (!order || !Number.isFinite(eventId) || !(heldThb > 0.005)) continue;
      const list = result.get(eventId) ?? [];
      list.push({
        orderId,
        price: Number(order.price) || 0,
        totalPrice: Number(order.total_price) || 0,
        heldThb,
        paid: order.status === 'paid',
        refundInProgress: order.status === 'paid' && order.refundStatus === 'refund_in_progress',
      });
      result.set(eventId, list);
    }
    return result;
  }

  /** Касса одного события (оценка) из готового состояния. */
  static eventCash(state: FinanceCashState, eventId: number): CashFlowState {
    return state.byEvent.get(eventId) ?? emptyCash();
  }

  /** Наличные заказы события, чьи деньги ещё не в сейфе. */
  static eventHeldOrders(state: FinanceCashState, eventId: number): FinanceHeldCashOrder[] {
    return state.heldOrdersByEvent.get(eventId) ?? [];
  }

  /** Инкассации без квитанции сейфа, новые первыми. */
  async listInTransit(): Promise<FinanceEncashment[]> {
    const confirmedIds = await this.receiptModel.distinct('ledgerEntryId').exec();
    const rows = await this.ledgerModel
      .find({ type: 'encashment', id: { $nin: confirmedIds } })
      .sort({ createdAt: -1, id: -1 })
      .select('id cashierId cashierEmail amount collectorName note createdAt')
      .lean<LeanLedgerRow[]>()
      .exec();
    return rows.map((row) => ({
      ledgerEntryId: row.id,
      createdAt: toIsoOrNull(row.createdAt) ?? '',
      cashierId: Number(row.cashierId) || 0,
      cashierEmail: row.cashierEmail ?? '',
      collectorName: row.collectorName ?? '',
      amount: round2(-(Number(row.amount) || 0)),
      note: row.note ?? '',
    }));
  }

  /**
   * Подтвердить поступление инкассаций в сейф. Идемпотентно: уже подтверждённые
   * пропускаются; строки не типа 'encashment' (или несуществующие) — 400, и
   * тогда не записывается ничего.
   */
  async confirmVaultReceipts(
    adminId: string | number,
    ledgerEntryIds: number[],
    note?: string | null,
  ): Promise<{ confirmed: number }> {
    const ids = [...new Set(ledgerEntryIds.map(Number))];
    if (!ids.length || ids.length > FINANCE_VAULT_CONFIRM_MAX || ids.some((id) => !Number.isInteger(id) || id < 1)) {
      throw new BadRequestException(FINANCE_NOT_ENCASHMENT);
    }
    const rows = await this.ledgerModel
      .find({ id: { $in: ids } })
      .select('id type amount')
      .lean<Array<Pick<LeanLedgerRow, 'id' | 'type' | 'amount'>>>()
      .exec();
    if (rows.length !== ids.length || rows.some((row) => row.type !== 'encashment' || !(Number(row.amount) < 0))) {
      throw new BadRequestException(FINANCE_NOT_ENCASHMENT);
    }

    const already = new Set<number>(
      (await this.receiptModel.distinct('ledgerEntryId', { ledgerEntryId: { $in: ids } }).exec()).map(Number),
    );
    const pending = rows.filter((row) => !already.has(row.id)).sort((a, b) => a.id - b.id);
    if (!pending.length) return { confirmed: 0 };

    const label = await this.directory.resolveAdminLabel(adminId);
    const adminNumericId = Number(adminId);
    const trimmedNote = (note ?? '').trim();
    const receivedAt = new Date();
    // Уникальный индекс ledgerEntryId должен существовать до первой записи.
    await this.receiptModel.init();
    let confirmed = 0;
    for (const row of pending) {
      try {
        await new this.receiptModel({
          ledgerEntryId: row.id,
          amount: -Number(row.amount),
          receivedAt,
          receivedByAdminId: Number.isInteger(adminNumericId) ? adminNumericId : 0,
          receivedByLabel: label,
          note: trimmedNote,
        }).save();
        confirmed += 1;
      } catch (error) {
        // Параллельное подтверждение той же строки — уникальный индекс, просто пропускаем.
        if ((error as { code?: number })?.code === 11000) continue;
        throw error;
      }
    }
    return { confirmed };
  }
}
