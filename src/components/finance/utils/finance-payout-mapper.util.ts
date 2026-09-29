import type { IOrganizerPayout, IOrganizerPayoutReceipt } from '../schemas/organizer-payout.schema';
import type {
  FinanceCurrency,
  FinancePayout,
  FinanceReceipt,
  OrganizerPayout,
  PayoutSource,
  PayoutStatus,
  PayoutType,
} from '../types/finance.types';
import { receiptKind } from './finance-files.util';
import { round2, toIsoOrNull } from './finance-money.util';

/** Выплата так, как её возвращает `.lean()`. */
export type LeanOrganizerPayout = Pick<
  IOrganizerPayout,
  | 'id'
  | 'eventId'
  | 'organizerId'
  | 'amount'
  | 'rateToThb'
  | 'amountThb'
  | 'requestedByOrganizer'
  | 'createdById'
  | 'createdByLabel'
> & {
  type: PayoutType;
  currency: FinanceCurrency;
  source?: PayoutSource | null;
  status: PayoutStatus;
  note?: string | null;
  receipts?: IOrganizerPayoutReceipt[];
  createdByKind: string;
  resolvedAt?: Date | null;
  resolvedByLabel?: string | null;
  rejectReason?: string | null;
  createdAt: Date;
};

export function payoutDisplayId(payoutId: number): string {
  return `PO-${payoutId}`;
}

export function toFinanceReceipt(receipt: IOrganizerPayoutReceipt): FinanceReceipt {
  return {
    id: String(receipt.id),
    name: receipt.name,
    kind: receiptKind(receipt.mimeType),
    mimeType: receipt.mimeType,
    size: Number(receipt.size) || 0,
    uploadedAt: toIsoOrNull(receipt.uploadedAt) ?? '',
  };
}

export function toFinancePayout(payout: LeanOrganizerPayout, eventTitle: string): FinancePayout {
  return {
    id: payoutDisplayId(payout.id),
    payoutId: payout.id,
    eventId: payout.eventId,
    eventTitle,
    createdAt: toIsoOrNull(payout.createdAt) ?? '',
    amount: round2(payout.amount),
    currency: payout.currency,
    rateToThb: payout.rateToThb,
    amountThb: round2(payout.amountThb),
    type: payout.type,
    source: payout.source ?? null,
    status: payout.status,
    note: payout.note ?? '',
    receipts: (payout.receipts ?? []).map(toFinanceReceipt),
    createdBy: payout.createdByLabel ?? '',
    requestedByOrganizer: payout.requestedByOrganizer === true,
    resolvedAt: toIsoOrNull(payout.resolvedAt),
    resolvedBy: payout.resolvedByLabel ?? null,
    rejectReason: payout.rejectReason ?? null,
  };
}

/** Выплата для кабинета организатора: pending → inProcess, vault → cash. */
export function toOrganizerPayout(payout: FinancePayout): OrganizerPayout {
  return {
    id: payout.id,
    payoutId: payout.payoutId,
    createdAt: payout.createdAt,
    amount: payout.amount,
    currency: payout.currency,
    amountThb: payout.amountThb,
    method: payout.source === null ? null : payout.source === 'vault' ? 'cash' : payout.source,
    status: payout.status === 'pending' ? 'inProcess' : payout.status,
    note: payout.note,
    rejectReason: payout.rejectReason,
    receipts: payout.receipts.map((receipt) => ({ id: receipt.id, name: receipt.name, kind: receipt.kind })),
  };
}
