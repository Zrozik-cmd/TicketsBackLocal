import type { EventStatus } from "../../events/constants/event-status.constant";
import type {
  IEventDate,
  ILocalizedText,
} from "../../events/schemas/event.schema";
import type {
  MockOrderPaymentCurrency,
  MockOrderPaymentMethod,
  MockOrderStatus,
  RefundStatus,
} from "../../mock-orders/schemas/mock-order.schema";
import type {
  AdminEventDeletionBlocker,
  AdminEventDeletionWarning,
} from "./admin-event.types";

/*
 * Служебные инструменты админки (скрытая страница /admin/vault): обзор событий
 * для очистки и удаление билетов без следа.
 */

/** Одна строка обзора событий: всё, что нужно, чтобы решить, можно ли удалять. */
export type AdminVaultEventRow = {
  id: number;
  title: ILocalizedText;
  status: EventStatus;
  isDraft: boolean;
  hiddenFromSite: boolean;
  /** Организатор перенёс событие в архив (флаг, не статус). */
  archivedByOrganizer: boolean;
  softDeleted: boolean;
  city: string | null;
  eventDate: IEventDate;
  /** Последний день события (для регулярных — конец периода) раньше сегодняшнего по ICT. */
  isPast: boolean;
  isRecurring: boolean;
  creator: number;
  organizerName: string;
  organizerEmail: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** Сумма мест по зонам. */
  capacity: number;
  /** Документы билетов (выпущенные, включая отсканированные). */
  tickets: number;
  usedTickets: number;
  /** Все 7 статусов присутствуют всегда (0, если заказов нет). */
  orders: Record<MockOrderStatus, number> & { total: number };
  /** Сумма total_price оплаченных заказов (THB). */
  paidRevenueTHB: number;
  lastOrderAt: string | null;
  sessions: number;
  reviews: number;
  favorites: number;
  managers: number;
  promoCodes: number;
  activeBannerIds: number[];
  inactiveBanners: number;
  /** Выплаты организатору по событию, любой статус. */
  payouts: number;
  /** Точки ARBI Pay (active/pending): есть — удаление мягкое. */
  arbipayStores: number;
  blockers: AdminEventDeletionBlocker[];
  warnings: AdminEventDeletionWarning[];
  /** blockers.length === 0 */
  canDelete: boolean;
};

export type AdminVaultEventsResult = {
  items: AdminVaultEventRow[];
  total: number;
  page: number;
  limit: number;
  /** Сколько событий из найденных (до пагинации, без фильтра deletable) можно удалить. */
  deletableTotal: number;
};

export type AdminVaultTicketSearchField =
  | "auto"
  | "email"
  | "code"
  | "ticketId"
  | "orderId"
  | "bookingCode"
  | "name"
  | "phone"
  | "event";

export type AdminVaultTicketItem = {
  ticket: {
    id: number;
    code: string;
    /** Заказ билета — и когда самого заказа уже нет (order: null). */
    orderId: number;
    status: string;
    price: number;
    currency: string;
    sectorId: string;
    sectorName: string;
    zoneId: string;
    zoneName: string;
    session: {
      id: number;
      date: string | null;
      start: string | null;
      end: string | null;
      cancelled: boolean;
    } | null;
    createdAt: string | null;
    usedAt: string | null;
  };
  order: {
    id: number;
    status: MockOrderStatus;
    refundStatus: RefundStatus;
    paymentMethod: MockOrderPaymentMethod | null;
    paymentMethodLabel: string;
    paymentCurrency: MockOrderPaymentCurrency;
    price: number;
    totalPrice: number;
    vat: number;
    additionalTicketCostFee: number;
    bankCardFee: number | null;
    cashFee: number | null;
    originalPaidAmount: number | null;
    promoCodeId: string | null;
    promocodeDiscount: number | null;
    /** Сумма count по строкам заказа. */
    lineTicketCount: number;
    /** Сколько документов билетов заказа существует сейчас. */
    liveTicketCount: number;
    createdAt: string | null;
    updatedAt: string | null;
    paymentConfirmedAt: string | null;
    bookingCode: string | null;
    cashierEmail: string | null;
    actualPos: string | null;
    ticketEmailStatus: string | null;
  } | null;
  buyer: {
    id: number;
    fullname: string | null;
    email: string | null;
    phone: string | null;
  } | null;
  event: {
    id: number;
    title: ILocalizedText;
    status: EventStatus;
    hiddenFromSite: boolean;
    archivedByOrganizer: boolean;
    eventDate: IEventDate;
    city: string | null;
    isRecurring: boolean;
    creator: number;
    organizerName: string;
  } | null;
  /** Оплаченный заказ без возврата в процессе. */
  removable: boolean;
};

export type AdminVaultTicketsResult = {
  items: AdminVaultTicketItem[];
  total: number;
  page: number;
  limit: number;
};

export type TicketRemovalBlocker =
  | "ticket_not_found"
  | "multiple_orders"
  | "order_not_found"
  | "order_not_paid"
  | "refund_in_progress"
  | "order_line_mismatch"
  | "order_tickets_mismatch"
  | "removal_unfinished"
  | "cash_sale_row_missing";

export type TicketRemovalWarning =
  | "ticket_used"
  | "order_deleted"
  | "cash_order"
  | "cash_till_negative"
  | "payment_provider_record"
  | "referral_share"
  | "referral_paid_out_exceeds"
  | "promo_order"
  | "tickets_email_sent"
  | "scanner_offline_cache"
  | "external_notifications";

export type TicketRemovalOrderMoney = {
  ticketCount: number;
  price: number;
  vat: number;
  additionalTicketCostFee: number;
  bankCardFee: number | null;
  cashFee: number | null;
  totalPrice: number;
  originalPaidAmount: number | null;
  promocodeDiscount: number | null;
};

export type TicketRemovalPreview = {
  /** Одному билету — `REMOVE <code>`, нескольким — `REMOVE <n> TICKETS FROM ORDER <orderId>`. */
  confirmationPhrase: string;
  canRemove: boolean;
  blockers: TicketRemovalBlocker[];
  blockerDetails: {
    missingTicketIds: number[];
    orderStatus: string | null;
    /** Issued Ticket documents of the order / tickets its lines list (order found only). */
    liveTicketCount: number | null;
    lineTicketCount: number | null;
    /** `ticketremovals` record of an earlier removal of this order that did not finish. */
    unfinishedRemovalId: string | null;
    unfinishedRemovalState: string | null;
  };
  warnings: TicketRemovalWarning[];
  warningDetails: { usedTickets: number; paymentMethodLabel: string | null };
  order: {
    id: number;
    status: string;
    paymentMethod: string | null;
    paymentMethodLabel: string;
    paymentCurrency: string;
    /** ISO; передаётся обратно как expectedOrderUpdatedAt. */
    updatedAt: string;
    action: "update" | "delete";
    before: TicketRemovalOrderMoney;
    /** null — заказ удаляется целиком. */
    after: TicketRemovalOrderMoney | null;
  } | null;
  cashLedger: {
    cashierId: number;
    cashierEmail: string;
    saleBefore: number;
    /** null — строка продажи удаляется. */
    saleAfter: number | null;
    tillBefore: number;
    tillAfter: number;
  } | null;
  referral: {
    shareBefore: number;
    /** null — доля удаляется. */
    shareAfter: number | null;
    paidOutExceeds: boolean;
  } | null;
  promo: { promoCodeId: string; decrement: number } | null;
  tickets: Array<{
    id: number;
    code: string;
    status: string;
    sectorName: string;
    zoneName: string;
    price: number;
    currency: string;
    session: { date: string | null; start: string | null; end: string | null } | null;
  }>;
};

export type TicketRemovalResult = {
  ok: true;
  removalId: string;
  orderId: number;
  orderAction: "updated" | "deleted";
  removedTicketIds: number[];
  sideEffectErrors: string[];
};
