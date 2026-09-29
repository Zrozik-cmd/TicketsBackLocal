/**
 * «Главное событие» на первом экране сайта (hero).
 *
 * По умолчанию (`default`) бекенд сам берёт ближайшее опубликованное событие, на которое ещё
 * продаются билеты, а если таких нет — ближайшее опубликованное (EventsService.getHeroEvent).
 * Админ может закрепить конкретное событие: оно показывается, пока не пройдёт (утилита
 * events/utils/event-end.util.ts), после чего режим сам возвращается к умолчанию.
 */

/** Единственный документ настройки. */
export const HOME_HERO_SETTING_KEY = 'home';

/** Почему закреплённое событие снято (для лога и админки). */
export const HOME_HERO_RESET_REASONS = ['admin', 'event_over', 'event_finished', 'event_deleted'] as const;
export type HomeHeroResetReason = (typeof HOME_HERO_RESET_REASONS)[number];

/** Статусы, после которых событие уже не вернётся на сайт: закрепление снимается. */
export const HOME_HERO_FINAL_EVENT_STATUSES = ['COMPLETED', 'CANCELLED', 'REJECTED'] as const;

/** Коды ошибок API (фронт админки переводит их). */
export const HOME_HERO_ERRORS = {
  eventNotFound: 'home_hero_event_not_found',
  notActive: 'home_hero_event_not_active',
  hidden: 'home_hero_event_hidden',
  over: 'home_hero_event_over',
} as const;

/** Как часто крон проверяет, не прошло ли закреплённое событие. */
export const HOME_HERO_RESET_CRON = '*/5 * * * *';
