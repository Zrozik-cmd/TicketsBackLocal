import type { EventStatus } from "../../events/constants/event-status.constant";
import type { OrganizerVerificationStatus } from "../../users/schemas/user.schema";
import type { MockOrderStatus } from "../../mock-orders/schemas/mock-order.schema";
import type {
  ILocalizedText,
  IEventDate,
  IIdLabel,
  ITime,
  IVenue,
  ISector,
  IExternalLink,
  EventCity,
  IRecurrence,
  SalesCloseBefore,
  EventTicketFormat,
} from "../../events/schemas/event.schema";
import type {
  EventModerationChange,
  EventPaymentOptionsSummary,
} from "../../events/utils/event-moderation-shape.util";

/** Sponsor as the admin sees it; `logo` is a public Media id, `name`/`url` are `''` when not set. */
export type AdminEventSponsor = {
  id: string;
  logo: number;
  name: string;
  url: string;
};

/** Everything the organizer changed since the last approval (`event_approval_snapshots`). */
export type AdminEventChanges = {
  /** ISO time of the last approval; `null` when the event has no approval snapshot. */
  baselineAt: string | null;
  /**
   * Changed top-level moderation fields (canonical before/after, `null` = not set), in a
   * stable order; `[]` without a snapshot. The current side's sponsors are
   * `pendingSponsors ?? sponsors`.
   */
  fields: EventModerationChange[];
};

export type AdminEventListItem = {
  id: number;
  creator: number;
  organizerName: string;
  /** Прошёл ли организатор проверку документов; у старых аккаунтов — approved. */
  organizerVerificationStatus: OrganizerVerificationStatus;
  status: EventStatus;
  title: ILocalizedText;
  category: IIdLabel;
  province: IIdLabel;
  /** Гео-раздел афиши; null у событий до разделения. */
  city: EventCity | null;
  venue: string;
  eventDate: IEventDate;
  sold: number;
  capacity: number;
  /** Runs on a repeating schedule rather than a single date. */
  isRecurring: boolean;
  /** Организатор скрыл событие с сайта (отдельный флаг, не статус). */
  hiddenFromSite: boolean;
  /** Организатор перенёс событие с продажами в архив (не статус): его нет на сайте. */
  archivedByOrganizer: boolean;
  /** Мягко удалено (есть точка ARBI Pay): архивно, организатор его не видит, админка — видит. */
  softDeleted: boolean;
  /** Организатор изменил спонсоров, изменения ждут одобрения админа. */
  hasPendingSponsors: boolean;
  rejectReason?: string;
  createdAt: Date;
};

export type AdminEventsListResult = {
  items: AdminEventListItem[];
  total: number;
  page: number;
  limit: number;
};

export type AdminEventDetails = {
  id: number;
  creator: number;
  status: EventStatus;
  title: ILocalizedText;
  description: ILocalizedText;
  eventLanguage: string;
  coverImage: number;
  seatingPlanImage?: number;
  seatingPlanSeats?: number;
  parkingPlanImage?: number;
  parkingPlanSeats?: number;
  eventDate: IEventDate;
  time: ITime;
  category: IIdLabel;
  tags: IIdLabel[];
  province: IIdLabel;
  /** Гео-раздел афиши; null у событий до разделения. */
  city: EventCity | null;
  venue: IVenue;
  sectors: ISector[];
  externalLinks: IExternalLink[];
  refundPolicy?: ILocalizedText;
  /** Организатор скрыл событие с сайта (отдельный флаг, не статус). */
  hiddenFromSite: boolean;
  /** Организатор перенёс событие с продажами в архив (не статус): его нет на сайте. */
  archivedByOrganizer: boolean;
  /** Мягко удалено (есть точка ARBI Pay): кем и когда; организатор событие больше не видит. */
  softDeleted: boolean;
  softDeletedAt: Date | null;
  softDeletedBy: string | null;
  rejectReason?: string;
  createdAt: Date;
  updatedAt: Date;
  organizerName: string;
  /** Прошёл ли организатор проверку документов; у старых аккаунтов — approved. */
  organizerVerificationStatus: OrganizerVerificationStatus;
  sold: number;
  capacity: number;
  vatPercent: number;
  additionalTicketCostFeePercent: number;
  processingFeePercent: number;
  platformFeePercent: number;
  /** Сервисная комиссия за наличные (%). */
  cashFeePercent: number;
  /** Оплата наличными включена (то же значение, что видит сайт). */
  cashEnabled: boolean;
  /** Extra hero photos (Media ids) in display order. */
  galleryImages: number[];
  /** Repeating schedule as stored; `null` for a one-off event. */
  recurrence: IRecurrence | null;
  venueSchedule: string | null;
  salesCloseBefore: SalesCloseBefore | null;
  /** Organizer's ticket-copy mailbox (private to the organizer and admins). */
  ticketCopyEmail: string | null;
  paymentOptions: EventPaymentOptionsSummary;
  /** Approved sponsors: what tickets render. */
  sponsors: AdminEventSponsor[];
  /** Organizer's list awaiting approval; `null` when nothing is pending, `[]` = all removed. */
  pendingSponsors: AdminEventSponsor[] | null;
  pendingSponsorsAt: string | null;
  /** Format of the tickets attached to e-mails. */
  ticketFormat: EventTicketFormat;
  changes: AdminEventChanges;
};

/** Причины, по которым событие нельзя удалить (deletion-check и delete). */
export type AdminEventDeletionBlocker =
  | "has_wait_orders"
  | "has_pending_cash_orders"
  | "has_paid_orders"
  | "has_refunded_orders"
  | "has_tickets"
  | "has_payouts"
  | "linked_from_active_banner";

/** Последствия удаления, которые не блокируют его. */
export type AdminEventDeletionWarning =
  | "event_is_active"
  | "event_page_public"
  | "cash_bookings_unrecoverable"
  | "failed_orders_left"
  | "reviews_left"
  | "favorites_left"
  | "managers_detached"
  | "promo_codes_left"
  | "inactive_banner_links"
  /** Есть точка ARBI Pay: событие не удаляется из базы, а помечается удалённым (softDeleted). */
  | "soft_delete_arbipay_store";

export type AdminEventDeletionCounts = {
  /** Все 7 статусов присутствуют всегда (0, если заказов нет). */
  orders: Record<MockOrderStatus, number> & { total: number };
  tickets: number;
  sessions: number;
  reviews: number;
  favorites: number;
  /** Менеджеры с этим событием в events[] или в старом поле event. */
  managers: number;
  /** Промокоды с String(id) в applicableEventIds. */
  promoCodes: number;
  /** Активные баннеры, href которых ведёт на событие. */
  activeBanners: number;
  inactiveBanners: number;
  /** Выплаты организатору по событию, любой статус (финансовые записи). */
  payouts: number;
  /** Точки ARBI Pay события (active/pending): есть — удаление мягкое. */
  arbipayStores: number;
};

export type AdminEventDeletionCheck = {
  id: number;
  title: ILocalizedText;
  status: EventStatus;
  hiddenFromSite: boolean;
  /** Организатор перенёс событие в архив. */
  archivedByOrganizer: boolean;
  /** Ровно `DELETE ${id}`, например "DELETE 123". */
  confirmationPhrase: string;
  counts: AdminEventDeletionCounts;
  /** id активных баннеров, которые блокируют удаление. */
  activeBannerIds: number[];
  blockers: AdminEventDeletionBlocker[];
  warnings: AdminEventDeletionWarning[];
  /** blockers.length === 0 */
  canDelete: boolean;
};

export type AdminEventDeleteResult = {
  ok: true;
  id: number;
  /** Снимок в `deletedevents`; `null` при мягком удалении (документ события остаётся). */
  archiveId: string | null;
  /** true — событие мягко удалено (есть точка ARBI Pay), а не удалено из базы. */
  softDeleted: boolean;
};

export type AdminEventCashPaymentWarning =
  | "no_visible_cash_locations"
  | "no_active_cashiers"
  | "event_sales_closed"
  | "event_hidden_from_site";

export type AdminEventCashPaymentState = {
  id: number;
  /** То же значение, что видит сайт: есть paymentOptions.thb и cashEnabled === true. */
  cashEnabled: boolean;
  cashFeePercent: number;
  status: EventStatus;
  hiddenFromSite: boolean;
  /** Организатор перенёс событие в архив. */
  archivedByOrganizer: boolean;
  /** Видимые карточки пунктов оплаты на опубликованной странице locations-page. */
  visibleCashLocations: number;
  /** Кассиры, которые не деактивированы. */
  activeCashiers: number;
  warnings: AdminEventCashPaymentWarning[];
};
