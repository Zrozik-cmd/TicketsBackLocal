import { Injectable, NotFoundException } from '@nestjs/common';
import {
  eventFeeRatesFromPercents,
  resolveEventFeePercents,
} from '../../events/utils/event-fee.util';
import {
  financeAdminModel,
  financeEventModel,
  financeMockOrderModel,
  financeUserModel,
} from '../finance-models';
import { organizerPayoutModel } from '../schemas/organizer-payout.schema';
import { FinanceEventRecord, FinanceOrganizer } from '../types/finance.types';

/** Статусы, в которых событие попадает в список финансов само по себе (spec §1.7). */
export const FINANCE_LISTED_EVENT_STATUSES = ['ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED'] as const;
/** Заказы, наличие которых добавляет событие в список в любом статусе. */
export const FINANCE_SOLD_ORDER_STATUSES = ['paid', 'refunded'] as const;

export const FINANCE_EVENT_NOT_FOUND = 'finance_event_not_found';

const EVENT_FIELDS =
  'id creator status title eventDate recurrence softDeleted processingFeePercent platformFeePercent ' +
  'vatPercent additionalTicketCostFeePercent cashFeePercent';

type LeanEvent = {
  id: number;
  creator?: number;
  status?: string;
  title?: { en?: string; th?: string; ru?: string };
  eventDate?: { startDate?: string };
  recurrence?: { enabled?: boolean; periodStart?: string };
  softDeleted?: boolean;
  processingFeePercent?: number;
  platformFeePercent?: number;
  vatPercent?: number;
  additionalTicketCostFeePercent?: number;
  cashFeePercent?: number;
};

type LeanUser = {
  id: number;
  email?: string;
  phoneNumber?: string;
  companyVenueName?: string;
  displayName?: string;
  responsiblePersonFullName?: string;
};

const clean = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** en → th → ru → `#id`. */
export function financeEventTitle(event: Pick<LeanEvent, 'id' | 'title'>): string {
  const title = event.title ?? {};
  return clean(title.en) || clean(title.th) || clean(title.ru) || `#${event.id}`;
}

export function missingOrganizer(id: number): FinanceOrganizer {
  return { id, name: `#${id}`, company: '', email: '', phone: '' };
}

function toOrganizer(id: number, user: LeanUser | undefined): FinanceOrganizer {
  if (!user) return missingOrganizer(id);
  const email = clean(user.email);
  return {
    id,
    name: clean(user.displayName) || clean(user.responsiblePersonFullName) || email || `#${id}`,
    company: clean(user.companyVenueName),
    email,
    phone: clean(user.phoneNumber),
  };
}

/**
 * Справочник финансов: какие события показывать, их организаторы, текущие
 * ставки комиссий, подписи админов. Только чтение чужих коллекций.
 */
@Injectable()
export class FinanceDirectoryService {
  private get eventModel() {
    return financeEventModel();
  }

  private get userModel() {
    return financeUserModel();
  }

  private get orderModel() {
    return financeMockOrderModel();
  }

  private get adminModel() {
    return financeAdminModel();
  }

  private get payoutModel() {
    return organizerPayoutModel();
  }

  /** Все события списка финансов (spec §1.7), новые первыми. */
  async listAdminEvents(): Promise<FinanceEventRecord[]> {
    const [base, soldIds, payoutIds] = await Promise.all([
      this.eventModel
        .find({ softDeleted: { $ne: true }, status: { $in: [...FINANCE_LISTED_EVENT_STATUSES] } })
        .select(EVENT_FIELDS)
        .lean<LeanEvent[]>()
        .exec(),
      this.orderModel.distinct('event', { status: { $in: [...FINANCE_SOLD_ORDER_STATUSES] } }).exec(),
      this.payoutModel.distinct('eventId').exec(),
    ]);

    const byId = new Map<number, LeanEvent>();
    for (const event of base) byId.set(event.id, event);
    const extraIds = new Set<number>();
    for (const raw of [...soldIds, ...payoutIds]) {
      const id = Number(raw);
      if (Number.isFinite(id) && !byId.has(id)) extraIds.add(id);
    }
    if (extraIds.size) {
      const extra = await this.eventModel
        .find({ id: { $in: [...extraIds] } })
        .select(EVENT_FIELDS)
        .lean<LeanEvent[]>()
        .exec();
      for (const event of extra) byId.set(event.id, event);
    }

    const records = await this.toRecords(
      [...byId.values()],
      [...extraIds].filter((id) => !byId.has(id)),
    );
    return records.sort((a, b) => b.id - a.id);
  }

  /** Событие из списка финансов; иначе 404 `finance_event_not_found`. */
  async getAdminEvent(eventId: number): Promise<FinanceEventRecord> {
    if (!Number.isInteger(eventId) || eventId < 1) throw new NotFoundException(FINANCE_EVENT_NOT_FOUND);
    const event = await this.eventModel.findOne({ id: eventId }).select(EVENT_FIELDS).lean<LeanEvent>().exec();
    const listedByStatus =
      !!event &&
      event.softDeleted !== true &&
      (FINANCE_LISTED_EVENT_STATUSES as readonly string[]).includes(event.status ?? '');
    if (!listedByStatus) {
      const [sold, paid] = await Promise.all([
        this.orderModel.exists({ event: eventId, status: { $in: [...FINANCE_SOLD_ORDER_STATUSES] } }).exec(),
        this.payoutModel.exists({ eventId }).exec(),
      ]);
      if (!sold && !paid) throw new NotFoundException(FINANCE_EVENT_NOT_FOUND);
    }
    const [record] = await this.toRecords(event ? [event] : [], event ? [] : [eventId]);
    return record;
  }

  /**
   * Любое существующее событие, без правил списка — для кабинета организатора
   * (владение проверяет вызывающий). Нет документа — 404.
   */
  async findEventRecord(eventId: number): Promise<FinanceEventRecord> {
    if (!Number.isInteger(eventId) || eventId < 1) throw new NotFoundException(FINANCE_EVENT_NOT_FOUND);
    const event = await this.eventModel.findOne({ id: eventId }).select(EVENT_FIELDS).lean<LeanEvent>().exec();
    if (!event) throw new NotFoundException(FINANCE_EVENT_NOT_FOUND);
    const [record] = await this.toRecords([event], []);
    return record;
  }

  /** Названия событий пачкой (для списков выплат). */
  async eventTitles(eventIds: number[]): Promise<Map<number, string>> {
    const ids = [...new Set(eventIds.filter((id) => Number.isFinite(id)))];
    const titles = new Map<number, string>();
    if (!ids.length) return titles;
    const events = await this.eventModel
      .find({ id: { $in: ids } })
      .select('id title')
      .lean<Array<Pick<LeanEvent, 'id' | 'title'>>>()
      .exec();
    for (const event of events) titles.set(event.id, financeEventTitle(event));
    for (const id of ids) if (!titles.has(id)) titles.set(id, `#${id}`);
    return titles;
  }

  /** Email админа (как в журнале касс), иначе `admin#id`. */
  async resolveAdminLabel(adminId: string | number | null | undefined): Promise<string> {
    const id = Number(adminId);
    if (!Number.isInteger(id)) return `admin#${adminId ?? ''}`;
    const admin = await this.adminModel.findOne({ id }).select('email').lean<{ email?: string }>().exec();
    return clean(admin?.email) || `admin#${id}`;
  }

  private async toRecords(events: LeanEvent[], placeholderIds: number[]): Promise<FinanceEventRecord[]> {
    const creators = [
      ...new Set(events.map((event) => Number(event.creator)).filter((id) => Number.isFinite(id))),
    ];
    const users = creators.length
      ? await this.userModel
          .find({ id: { $in: creators } })
          .select('id email phoneNumber companyVenueName displayName responsiblePersonFullName')
          .lean<LeanUser[]>()
          .exec()
      : [];
    const userById = new Map<number, LeanUser>(users.map((user) => [user.id, user]));

    const records: FinanceEventRecord[] = events.map((event) => {
      const creator = Number.isFinite(Number(event.creator)) ? Number(event.creator) : 0;
      const percents = resolveEventFeePercents(event);
      const rates = eventFeeRatesFromPercents(percents);
      return {
        id: event.id,
        title: financeEventTitle(event),
        date: clean(event.eventDate?.startDate) || clean(event.recurrence?.periodStart) || '',
        kind: event.recurrence?.enabled === true ? 'regular' : 'oneOff',
        creator,
        organizer: toOrganizer(creator, userById.get(creator)),
        status: event.status ?? null,
        softDeleted: event.softDeleted === true,
        exists: true,
        fees: {
          platformPercent: percents.platformFeePercent,
          processingPercent: percents.processingFeePercent,
          platformRate: rates.platformFeeRate,
          processingRate: rates.processingFeeRate,
        },
      };
    });

    for (const id of placeholderIds) {
      const percents = resolveEventFeePercents({});
      const rates = eventFeeRatesFromPercents(percents);
      records.push({
        id,
        title: `#${id}`,
        date: '',
        kind: 'oneOff',
        creator: 0,
        organizer: missingOrganizer(0),
        status: null,
        softDeleted: false,
        exists: false,
        fees: {
          platformPercent: percents.platformFeePercent,
          processingPercent: percents.processingFeePercent,
          platformRate: rates.platformFeeRate,
          processingRate: rates.processingFeeRate,
        },
      });
    }
    return records;
  }
}
