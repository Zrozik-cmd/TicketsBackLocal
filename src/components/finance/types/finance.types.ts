/**
 * Контракт финансовой доски (spec §4). Те же формы лежат в lotus-admin
 * `lib/finance/finance-types.ts` и TicketsFront `lib/api/organizer-finance.ts` —
 * менять только синхронно со всеми тремя местами.
 *
 * Все суммы — числа, округлённые до сатанга на выходе; курсы — THB за 1 единицу.
 */

export const FINANCE_CURRENCIES = ['THB', 'RUB', 'USDT', 'KZT'] as const;
export type FinanceCurrency = (typeof FINANCE_CURRENCIES)[number];
export const FINANCE_PROVIDERS = ['arbiPay', 'omise', 'cash', 'other'] as const;
export type FinanceProvider = (typeof FINANCE_PROVIDERS)[number];
export type FinanceMoney = Record<FinanceCurrency, number>;
export type CashFlowState = { atCashier: number; inTransit: number; inVault: number };
export type PayoutType = 'advance' | 'interim' | 'final';
export type PayoutSource = 'vault' | 'arbiPay' | 'omise' | 'bankTransfer';
export type PayoutStatus = 'completed' | 'pending' | 'failed';
export type FinanceOrganizer = { id: number; name: string; company: string; email: string; phone: string };
export type FinanceEventOption = {
  id: number;
  title: string;
  date: string;
  kind: 'oneOff' | 'regular';
  organizer: FinanceOrganizer;
};
export type FinanceReceipt = {
  id: string;
  name: string;
  kind: 'image' | 'pdf' | 'other';
  mimeType: string;
  size: number;
  uploadedAt: string;
};
export type FinancePayout = {
  /** Display id `PO-<n>`. */
  id: string;
  payoutId: number;
  eventId: number;
  eventTitle: string;
  createdAt: string;
  amount: number;
  currency: FinanceCurrency;
  rateToThb: number;
  amountThb: number;
  type: PayoutType;
  source: PayoutSource | null;
  status: PayoutStatus;
  note: string;
  receipts: FinanceReceipt[];
  createdBy: string;
  requestedByOrganizer: boolean;
  resolvedAt: string | null;
  resolvedBy: string | null;
  rejectReason: string | null;
};
export type FinanceDailySales = { date: string; tickets: number; grossThb: number };
export type FinanceFilters = { currencies: FinanceCurrency[]; provider: FinanceProvider | null };
export type FinancePeriod = 'days7' | 'days30' | 'days90' | 'all' | 'custom';
export type FinancePeriodValue = { period: FinancePeriod; from: string; to: string };
export type FinanceFeesBreakdown = {
  platform: number;
  platformPercent: number;
  processing: number;
  processingPercent: number;
  processingByProvider: Record<FinanceProvider, number>;
  vat: number;
  service: number;
  cardFee: number;
  cashFee: number;
  total: number;
};
export type FinanceEventSummary = {
  id: number;
  title: string;
  date: string;
  kind: 'oneOff' | 'regular';
  organizer: FinanceOrganizer;
  ticketsSold: number;
  gross: FinanceMoney;
  grossThb: number;
  fees: FinanceFeesBreakdown;
  /** Organizer net of the filtered selection. */
  filteredNetThb: number;
  /** Balances — current state, independent of filters. */
  netThb: number;
  paidOutThb: number;
  pendingPayoutsThb: number;
  frozenThb: number;
  /**
   * Part of frozenThb: organizer net of paid orders for shows of a regular event that have not
   * taken place yet (or were cancelled) — payable once the show is over.
   */
  upcomingShowsThb: number;
  availableThb: number;
  cash: CashFlowState;
  /**
   * Money of the event at the provider, THB only (the other keys are 0): what the provider was
   * credited (Σ total_price) minus payouts made from it. Not the provider account balance —
   * Lotus does not see the platform's own withdrawals.
   */
  gatewayBalance: { arbiPay: FinanceMoney; omise: FinanceMoney };
  /** Paid non-THB orders without the amount in the payment currency (their THB is still in grossThb). */
  missingOriginalOrders: number;
};
export type FinanceBoard = {
  events: FinanceEventSummary[];
  /**
   * cash = exact overall; platformPercent/processingPercent = 0 in totals. availableThb = Σ of the
   * events' positive available (what can be paid out); overpaid events are in overpaidThb, not netted.
   */
  totals: Omit<FinanceEventSummary, 'id' | 'title' | 'date' | 'kind' | 'organizer'> & {
    /** Σ of negative available (overpaid events / advances), ≤ 0. */
    overpaidThb: number;
  };
  /** Part of totals.cash that FIFO could not attribute to an event. */
  unattributedCash: CashFlowState;
  dailySales: FinanceDailySales[];
  generatedAt: string;
};
export type FinanceEventDetails = {
  summary: FinanceEventSummary;
  dailySales: FinanceDailySales[];
  payouts: FinancePayout[];
  ticketsByProvider: Record<FinanceProvider, number>;
};
export type FinancePayoutContext = {
  eventId: number;
  organizer: FinanceOrganizer;
  netThb: number;
  paidOutThb: number;
  pendingPayoutsThb: number;
  frozenThb: number;
  /** Part of frozenThb: shows of a regular event that have not taken place yet. */
  upcomingShowsThb: number;
  availableThb: number;
  /** Overall inVault. */
  vaultThb: number;
  /** THB = 1. */
  rates: Record<FinanceCurrency, number | null>;
};
export type FinanceEncashment = {
  ledgerEntryId: number;
  createdAt: string;
  cashierId: number;
  cashierEmail: string;
  collectorName: string;
  amount: number;
  note: string;
};
export type CreatePayoutInput = {
  eventId: number;
  type: PayoutType;
  amount: number;
  currency: FinanceCurrency;
  rateToThb: number | null;
  source: PayoutSource;
  note: string;
  files: File[];
};

/* ------------------------------------------------------------------ */
/* Organizer contract (TicketsFront lib/api/organizer-finance.ts)      */
/* ------------------------------------------------------------------ */

/** pending → inProcess */
export type OrganizerPayoutStatus = 'completed' | 'inProcess' | 'failed';
/** vault → cash */
export type OrganizerPayoutMethod = 'bankTransfer' | 'arbiPay' | 'omise' | 'cash';
export type OrganizerPayoutReceipt = { id: string; name: string; kind: 'image' | 'pdf' | 'other' };
export type OrganizerPayout = {
  id: string;
  payoutId: number;
  createdAt: string;
  amount: number;
  currency: 'THB' | 'RUB' | 'USDT' | 'KZT';
  amountThb: number;
  method: OrganizerPayoutMethod | null;
  status: OrganizerPayoutStatus;
  note: string;
  rejectReason: string | null;
  receipts: OrganizerPayoutReceipt[];
};
export type OrganizerShow = { sessionId: number; date: string; start: string; sold: number; gross: number };
export type OrganizerFinance = {
  event: { id: number; title: string; isRecurring: boolean };
  sessionId: number | null;
  ticketsSold: number;
  ticketsRemaining: number;
  soldTrend: number[];
  remainingTrend: number[];
  gross: number;
  commissionPercent: number;
  commission: number;
  netProfit: number;
  paidOut: number;
  inProcess: number;
  frozen: number;
  /** Part of `frozen`: sales for shows that have not taken place yet (regular events). */
  upcomingShows: number;
  available: number;
  payouts: OrganizerPayout[];
  shows: OrganizerShow[];
};

/* ------------------------------------------------------------------ */
/* Backend-internal shapes (not part of the HTTP contract)             */
/* ------------------------------------------------------------------ */

export const PAYOUT_TYPES = ['advance', 'interim', 'final'] as const satisfies readonly PayoutType[];
export const PAYOUT_SOURCES = [
  'vault',
  'arbiPay',
  'omise',
  'bankTransfer',
] as const satisfies readonly PayoutSource[];
export const PAYOUT_STATUSES = ['pending', 'completed', 'failed'] as const satisfies readonly PayoutStatus[];
export const PAYOUT_CREATOR_KINDS = ['admin', 'organizer', 'manager'] as const;
export type PayoutCreatorKind = (typeof PAYOUT_CREATOR_KINDS)[number];

/** Admin filters of the board/event page (spec §1.8); null/[] = no restriction. */
export type FinanceSalesFilter = {
  currencies: FinanceCurrency[];
  provider: FinanceProvider | null;
  /** ICT day `YYYY-MM-DD`, inclusive. */
  from: string | null;
  to: string | null;
};

/** Who creates/resolves a payout — the label is what the history shows. */
export type FinancePayoutActor = { kind: PayoutCreatorKind; id: number; label: string };

/** Event as the finance module sees it (listing, organizer, current fee rates). */
export type FinanceEventRecord = {
  id: number;
  title: string;
  date: string;
  kind: 'oneOff' | 'regular';
  /** User.id of the organizer (0 when the event document is missing). */
  creator: number;
  organizer: FinanceOrganizer;
  status: string | null;
  softDeleted: boolean;
  /** false = placeholder for orders/payouts whose event document no longer exists. */
  exists: boolean;
  fees: FinanceFeeRates;
};

export type FinanceFeeRates = {
  platformPercent: number;
  processingPercent: number;
  platformRate: number;
  processingRate: number;
};

/** Event balances — current state, not affected by filters (spec §1.6). */
export type FinanceEventBalances = {
  eventId: number;
  netThb: number;
  paidOutThb: number;
  pendingPayoutsThb: number;
  frozenThb: number;
  /** Part of frozenThb: shows of a regular event that have not taken place yet. */
  upcomingShowsThb: number;
  /** May be negative (overpaid / advance); organizer views clamp it to ≥ 0. */
  availableThb: number;
  cash: CashFlowState;
  gatewayBalance: { arbiPay: FinanceMoney; omise: FinanceMoney };
  cashNetRatio: number;
  refundInProgressNetThb: number;
};

/** One currency line of a live provider balance. */
export type FinanceLiveBalanceLine = { currency: string; amount: number };

/**
 * Live balance of the ARBI Pay merchant account (payment microservice GET /balance/arbi).
 * Account-wide, not split by event. `balance` (settlement `currency`) subtracts only completed
 * payouts — «Доступный баланс» on the ARBI Pay payouts tab; `balances` per currency also sets aside
 * payouts in processing — tab «Балансы» (on dev the difference matched a pending payout exactly).
 */
export type FinanceArbiPayLiveBalance =
  | { status: 'ok'; currency: string; balance: number; balances: FinanceLiveBalanceLine[]; fetchedAt: string }
  | { status: 'unavailable'; reason: 'not_configured' | 'request_failed'; fetchedAt: string };

export type FinanceProviderLiveBalances = { arbiPay: FinanceArbiPayLiveBalance };

/** A file as multer (memory storage) hands it over. */
export type FinanceUploadedFile = {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  size: number;
};

/** A receipt ready to be streamed by a guarded download route. */
export type FinanceReceiptFile = { buffer: Buffer; mimeType: string; name: string };
