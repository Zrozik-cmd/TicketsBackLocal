import type { ILocalizedText } from '../../events/schemas/event.schema';
import type { EventStatus } from '../../events/constants/event-status.constant';

/** Почему событие сейчас нельзя закрепить. */
export type HomeHeroIneligibleReason = 'deleted' | 'not_active' | 'hidden' | 'over';

/**
 * Почему закреплённое событие сейчас не показывается. `not_active` (пауза, повторная
 * модерация) и `hidden` (скрыто или в архиве организатора) временные — закрепление держится;
 * `over` и удаление крон снимает сам в течение нескольких минут.
 */
export type HomeHeroNotShownReason = 'deleted' | 'not_active' | 'hidden' | 'over';

/** Ответ GET/PUT /admin/events/:id/home-hero. */
export type AdminHomeHeroState = {
  /** Событие, со страницы которого спрашивают. */
  eventId: number;
  /** Режим первого экрана сейчас. */
  mode: 'default' | 'event';
  /** Закреплено именно это событие. */
  selected: boolean;
  /** Закреплённое событие (это или другое); `null` в режиме по умолчанию. */
  featured: {
    id: number;
    title: ILocalizedText | null;
    status: EventStatus | null;
    setAt: Date | null;
    setByLabel: string | null;
    /** Когда закрепление снимется само (конец последнего показа, ICT); `null` — дата не читается. */
    endsAt: string | null;
    /** Показывается ли сейчас на сайте. */
    shownNow: boolean;
    notShownReason: HomeHeroNotShownReason | null;
  } | null;
  /** Можно ли закрепить это событие сейчас. */
  selectable: boolean;
  ineligibleReason: HomeHeroIneligibleReason | null;
  /** Когда это событие закончится (ICT-инстант в ISO); `null` — дата не читается. */
  endsAt: string | null;
  /** Последнее снятие закрепления (для подсказки «вернулось в режим по умолчанию»). */
  lastReset: { at: Date; reason: string | null; eventId: number | null } | null;
};
