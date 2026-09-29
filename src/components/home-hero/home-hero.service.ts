import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import mongoose from 'mongoose';
import { AdminSchema, IAdmin } from '../admin/schemas/admin.schema';
import { EventSchema, IEvent } from '../events/schemas/event.schema';
import { isHiddenFromSite } from '../events/constants/event-visibility.constant';
import { eventEndInstant, isEventOver } from '../events/utils/event-end.util';
import {
  HOME_HERO_ERRORS,
  HOME_HERO_FINAL_EVENT_STATUSES,
  HOME_HERO_RESET_CRON,
  HOME_HERO_SETTING_KEY,
  type HomeHeroResetReason,
} from './constants/home-hero.constants';
import { resetHomeHeroIfEvent } from './home-hero-links';
import { homeHeroSettingModel } from './schemas/home-hero-setting.schema';
import type { AdminHomeHeroState, HomeHeroIneligibleReason } from './types/home-hero.types';

type HeroEvent = Pick<
  IEvent,
  | 'id'
  | 'title'
  | 'status'
  | 'hiddenFromSite'
  | 'archivedByOrganizer'
  | 'softDeleted'
  | 'eventDate'
  | 'time'
  | 'recurrence'
>;

const HERO_EVENT_FIELDS = {
  id: 1,
  title: 1,
  status: 1,
  hiddenFromSite: 1,
  archivedByOrganizer: 1,
  softDeleted: 1,
  eventDate: 1,
  time: 1,
  recurrence: 1,
} as const;

const ERROR_BY_REASON: Record<HomeHeroIneligibleReason, string> = {
  deleted: HOME_HERO_ERRORS.eventNotFound,
  not_active: HOME_HERO_ERRORS.notActive,
  hidden: HOME_HERO_ERRORS.hidden,
  over: HOME_HERO_ERRORS.over,
};

/**
 * Закреплённое админом «главное событие» первого экрана (см. constants/home-hero.constants.ts).
 * Публичный hero читает настройку сам (home-hero-links.ts), здесь — админка и крон.
 */
@Injectable()
export class HomeHeroService {
  private readonly logger = new Logger(HomeHeroService.name);

  private get eventModel(): mongoose.Model<IEvent> {
    return (mongoose.models.Event as mongoose.Model<IEvent>) ?? mongoose.model<IEvent>('Event', EventSchema);
  }

  private get adminModel(): mongoose.Model<IAdmin> {
    return (mongoose.models.Admin as mongoose.Model<IAdmin>) ?? mongoose.model<IAdmin>('Admin', AdminSchema);
  }

  private loadEvent(id: number): Promise<HeroEvent | null> {
    return this.eventModel.findOne({ id }).select(HERO_EVENT_FIELDS).lean<HeroEvent>().exec();
  }

  /**
   * Почему событие нельзя показать на первом экране прямо сейчас (`null` — можно).
   * Та же проверка решает и «можно ли закрепить», и «показывается ли закреплённое».
   */
  private blockedReason(event: HeroEvent | null, now: number): HomeHeroIneligibleReason | null {
    if (!event || event.softDeleted === true) return 'deleted';
    if (event.status !== 'ACTIVE') return 'not_active';
    if (isHiddenFromSite(event)) return 'hidden';
    if (isEventOver(event, now)) return 'over';
    return null;
  }

  private endsAtIso(event: HeroEvent | null): string | null {
    const end = event ? eventEndInstant(event) : Number.NaN;
    return Number.isFinite(end) ? new Date(end).toISOString() : null;
  }

  /** Состояние для секции «Главное событие» на странице события в админке. Только чтение. */
  async getState(eventId: number, now: number = Date.now()): Promise<AdminHomeHeroState> {
    const [event, setting] = await Promise.all([
      this.loadEvent(eventId),
      homeHeroSettingModel().findOne({ key: HOME_HERO_SETTING_KEY }).lean().exec(),
    ]);
    if (!event) throw new NotFoundException(HOME_HERO_ERRORS.eventNotFound);

    const featuredId = setting?.eventId ?? null;
    const featuredEvent = featuredId == null ? null : featuredId === event.id ? event : await this.loadEvent(featuredId);
    const featuredBlocked = featuredId == null ? null : this.blockedReason(featuredEvent, now);
    const ineligibleReason = this.blockedReason(event, now);

    return {
      eventId: event.id,
      mode: featuredId == null ? 'default' : 'event',
      selected: featuredId === event.id,
      featured:
        featuredId == null
          ? null
          : {
              id: featuredId,
              title: featuredEvent?.title ?? null,
              status: featuredEvent?.status ?? null,
              setAt: setting?.setAt ?? null,
              setByLabel: setting?.setByLabel ?? null,
              endsAt: this.endsAtIso(featuredEvent),
              shownNow: featuredBlocked == null,
              notShownReason: featuredBlocked,
            },
      selectable: ineligibleReason == null,
      ineligibleReason,
      endsAt: this.endsAtIso(event),
      lastReset: setting?.resetAt
        ? { at: setting.resetAt, reason: setting.resetReason ?? null, eventId: setting.resetEventId ?? null }
        : null,
    };
  }

  /**
   * `featured: true` — закрепить это событие (заменяет прежний выбор); `false` — вернуть режим
   * по умолчанию, если закреплено именно оно (иначе ничего не меняется).
   */
  async setFeatured(eventId: number, featured: boolean, adminId: string | number): Promise<AdminHomeHeroState> {
    const event = await this.loadEvent(eventId);
    if (!event) throw new NotFoundException(HOME_HERO_ERRORS.eventNotFound);

    if (!featured) {
      if (await resetHomeHeroIfEvent(eventId, 'admin')) {
        this.logger.log(`Home hero: event ${eventId} unpinned by admin ${adminId}, back to the default mode`);
      }
      return this.getState(eventId);
    }

    const reason = this.blockedReason(event, Date.now());
    if (reason) throw new BadRequestException(ERROR_BY_REASON[reason]);

    const label = await this.adminLabel(adminId);
    const set = { eventId, setAt: new Date(), setByAdminId: Number(adminId) || null, setByLabel: label };
    const write = () =>
      homeHeroSettingModel()
        .updateOne({ key: HOME_HERO_SETTING_KEY }, { $set: set, $setOnInsert: { key: HOME_HERO_SETTING_KEY } }, { upsert: true })
        .exec();
    try {
      await write();
    } catch (error) {
      // Два первых сохранения одновременно: второе упирается в уникальный key — документ уже есть.
      if ((error as { code?: number })?.code !== 11000) throw error;
      await write();
    }
    this.logger.log(`Home hero: event ${eventId} pinned by ${label}`);
    return this.getState(eventId);
  }

  /**
   * Возвращает режим по умолчанию, когда закреплённое событие прошло, завершено/отменено
   * или удалено. Пауза и скрытие закрепление не снимают: пока они действуют, первый экран
   * просто показывает событие по умолчанию. Условная запись — повтор и второй инстанс безопасны.
   */
  @Cron(HOME_HERO_RESET_CRON)
  async resetFinishedPick(now: number = Date.now()): Promise<void> {
    const setting = await homeHeroSettingModel().findOne({ key: HOME_HERO_SETTING_KEY }).lean().exec();
    const eventId = setting?.eventId;
    if (eventId == null) return;
    const event = await this.loadEvent(eventId);
    let reason: HomeHeroResetReason | null = null;
    if (!event || event.softDeleted === true) reason = 'event_deleted';
    else if ((HOME_HERO_FINAL_EVENT_STATUSES as readonly string[]).includes(event.status)) reason = 'event_finished';
    else if (isEventOver(event, now)) reason = 'event_over';
    if (reason && (await resetHomeHeroIfEvent(eventId, reason))) {
      this.logger.log(`Home hero: event ${eventId} unpinned (${reason}), back to the default mode`);
    }
  }

  private async adminLabel(adminId: string | number): Promise<string> {
    const id = Number(adminId);
    if (!Number.isInteger(id)) return `admin#${adminId}`;
    const admin = await this.adminModel.findOne({ id }).select('email').lean<{ email?: string }>().exec();
    return admin?.email?.trim() || `admin#${id}`;
  }
}
