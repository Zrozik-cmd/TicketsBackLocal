import { HOME_HERO_SETTING_KEY, type HomeHeroResetReason } from './constants/home-hero.constants';
import { homeHeroSettingModel } from './schemas/home-hero-setting.schema';

/*
 * Точки входа для других модулей. Обычные функции, не сервис: их зовут EventsService
 * (публичный hero) и очистка удалённого события (events/event-soft-delete.ts), а EventsModule
 * — хаб, в который нельзя тянуть новые модули.
 */

/** Закреплённое админом событие первого экрана или `null` (режим по умолчанию). */
export async function featuredHomeHeroEventId(): Promise<number | null> {
  const setting = await homeHeroSettingModel()
    .findOne({ key: HOME_HERO_SETTING_KEY })
    .select({ eventId: 1 })
    .lean()
    .exec();
  const id = Number(setting?.eventId);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * Снимает закрепление, только если закреплено именно это событие (условная запись:
 * повтор, второй инстанс крона или гонка с новым выбором админа ничего не портят).
 * `true` — закрепление снято этим вызовом.
 */
export async function resetHomeHeroIfEvent(eventId: number, reason: HomeHeroResetReason): Promise<boolean> {
  const { modifiedCount } = await homeHeroSettingModel()
    .updateOne(
      { key: HOME_HERO_SETTING_KEY, eventId },
      { $set: { eventId: null, resetAt: new Date(), resetReason: reason, resetEventId: eventId } },
    )
    .exec();
  return modifiedCount > 0;
}
