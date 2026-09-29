import type { EventStatus } from "../../events/constants/event-status.constant";
import type { ILocalizedText } from "../../events/schemas/event.schema";
import type { OrganizerVerificationStatus } from "../../users/schemas/user.schema";

/** Has at least one event with status ACTIVE */
export type AdminUserListStatus = "active" | "inactive";

export type AdminUserListItem = {
  id: number;
  companyVenueName: string;
  displayName?: string;
  responsiblePersonFullName: string;
  email: string;
  phoneNumber: string;
  category: { id: string; label: string };
  provinceRegion: string;
  country?: string;
  eventsCount: number;
  status: AdminUserListStatus;
  /** Состояние заявки на проверку; у старых аккаунтов — approved. */
  verificationStatus: OrganizerVerificationStatus;
  createdAt: Date;
};

export type AdminUsersListResult = {
  items: AdminUserListItem[];
  total: number;
  page: number;
  limit: number;
};

/**
 * GET /admin/users/:id
 *
 * Path-only request; admin-authenticated.
 */
export interface GetAdminUserByIdRequest {
  id: number;
}

export interface GetAdminUserByIdResponse {
  id: number;
  companyVenueName: string;
  displayName?: string;
  category: { id: string; label: string };
  status: AdminUserListStatus;
  responsiblePersonFullName: string;
  email: string;
  phoneNumber: string;
  /** Composed from businessAddress, city, provinceRegion, country */
  location: string;
  createdAt: Date;
  eventsCount: number;
  defaultVatPercent: number;
  defaultProcessingFeePercent: number;
  defaultPlatformFeePercent: number;
  defaultAdditionalTicketCostFeePercent: number;

  /* --- проверка организатора --- */
  verificationStatus: OrganizerVerificationStatus;
  verificationReviewedAt?: Date;
  verificationReviewedBy?: string;
  verificationRejectReason?: string;
  /** Идентификационный номер компании в DBD, как его ввёл организатор. */
  companyRegistrationDbd?: string;
  taxRegistrationId?: string;
  /**
   * Есть ли загруженная выписка DBD. Сам файл приватный и отдаётся отдельным
   * админским маршрутом, поэтому наружу идёт только признак наличия.
   */
  hasDbdDocument: boolean;
}

/** Single organizer (user) profile for admin detail view — same shape as `GetAdminUserByIdResponse`. */
export type AdminUserDetails = GetAdminUserByIdResponse;

export type AdminUserEventListItem = {
  id: number;
  title: ILocalizedText;
  /** Event `description` (localized). */
  shortDescription: ILocalizedText;
  coverImageUrl: string;
  startDate: string;
  endDate: string;
  city: string;
  country: string;
  venueName: string;
  status: EventStatus;
  /** Set when status is REJECTED (admin moderation). */
  rejectReason?: string;
  minPrice: number;
  currency: string;
  /** Issued ticket documents for this event */
  soldTickets: number;
  /** Total capacity (sum of zone seats) */
  allTickets: number;
  /** Runs on a repeating schedule rather than a single date. */
  isRecurring: boolean;
  /** Организатор скрыл событие с сайта (отдельный флаг, не статус). */
  hiddenFromSite: boolean;
  /** Организатор перенёс событие с продажами в архив (не статус): его нет на сайте. */
  archivedByOrganizer: boolean;
  /** Мягко удалено (есть точка ARBI Pay): организатор его не видит. */
  softDeleted: boolean;
  organizerId: number;
  organizerDisplayName: string;
  organizerCompanyVenueName: string;
  createdAt: Date;
};

export type AdminUserEventsListResult = {
  items: AdminUserEventListItem[];
  total: number;
  page: number;
  limit: number;
};

/** GET /admin/users/:id/events/stats */
export type AdminEventsStats = {
  /** Issued ticket documents across all of this organizer's events (any status). */
  totalTicketsSold: number;
  /** Events with status ACTIVE for this organizer. */
  activeEventsCount: number;
};
