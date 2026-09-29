import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import mongoose from 'mongoose';
import { EventSchema, type IEvent } from '../events/schemas/event.schema';
import type { EventStatus } from '../events/constants/event-status.constant';
import { MockOrderSchema, type IMockOrder } from '../mock-orders/schemas/mock-order.schema';
import {
  eventArbiPayStoreModel,
  type EventArbiPayStoreStatus,
  type IEventArbiPayStore,
} from './schemas/event-arbipay-store.schema';
import { arbiPayStoreCodeForEvent } from './arbipay-store-code.util';
import { financeProviderExpr } from '../finance/utils/finance-provider.util';

const REQUEST_TIMEOUT_MS = 20000;
/** Максимальная длина названия точки в ARBIPAY. */
const STORE_NAME_MAX_LENGTH = 100;
/** Сколько текста ошибки храним в реестре. */
const ERROR_PREVIEW_CHARS = 300;
/** Пауза между повторами одной точки: столько ждёт крон, прежде чем пробовать снова. */
const RETRY_AFTER_MS = 10 * 60 * 1000;
/** Сколько точек крон добирает за один проход. */
const RETRY_BATCH = 20;
/** После такого числа неудач крон перестаёт трогать точку (остаётся в логах и реестре). */
const MAX_ATTEMPTS = 12;
/**
 * Для каких событий админ может завести точку вручную: опубликованы и ещё продают.
 * Черновик/модерация/отказ — точка появится сама после публикации; завершённым и
 * отменённым она уже не нужна, а код занимается навсегда.
 */
const MANUAL_STORE_EVENT_STATUSES: ReadonlySet<EventStatus> = new Set<EventStatus>(['ACTIVE', 'PAUSED']);

export type AdminArbiPayStoreIneligibleReason = 'not_published' | 'sales_finished';

/** Состояние точки события для карточки в админке. */
export type AdminArbiPayStoreState = {
  /** Модуль включён: ARBIPAY_STORES_ENABLED=true и заданы PAYMENT_* ключи микросервиса. */
  enabled: boolean;
  eventId: number;
  eventStatus: EventStatus;
  /** Можно ли сейчас завести точку вручную. */
  eligible: boolean;
  ineligibleReason: AdminArbiPayStoreIneligibleReason | null;
  /** Код, который получит точка этого события. */
  expectedCode: string | null;
  store: {
    status: EventArbiPayStoreStatus;
    code: string;
    name: string;
    storeId: string | null;
    currency: string | null;
    attempts: number;
    lastError: string | null;
    lastAttemptAt: Date | null;
    activatedAt: Date | null;
  } | null;
  /**
   * Оплаченные через ARBIPAY заказы события, которые прошли через общую точку мерчанта:
   * все такие заказы, пока точки нет, или созданные до её активации. Именно из-за них
   * статистика точки в кабинете ARBIPAY не совпадёт со статистикой события в Lotus.
   */
  paidOrdersOutsideStore: number;
};

type EnsureOutcome = {
  status: EventArbiPayStoreStatus;
  code: string;
  storeId: string | null;
  currency: string | null;
  error: string | null;
};

type StoreApiAnswer = {
  created?: unknown;
  adopted?: unknown;
  store?: { id?: unknown; code?: unknown; name?: unknown; effectiveCurrency?: unknown };
};

/**
 * Своя точка (store) ARBIPAY на каждое событие.
 *
 * Точка создаётся не при создании события, а когда событие впервые прошло модерацию
 * (админ нажал «Опубликовать»): до этого события может вообще не случиться, а код
 * точки в ARBIPAY занимается навсегда, даже после архивации.
 *
 * Создаёт точку не сам, а через платёжный микросервис (`POST /stores/arbi` теми же
 * ключами PAYMENT_CLIENT_KEY/PAYMENT_API_SECRET, что и платежи): приватный ключ
 * мерчанта ARBIPAY лежит только там и в Lotus не попадает. Мерчант точки — тот же, что у
 * платежей: его выбирает микросервис по ключу клиента (подключение `arbi` этого клиента).
 *
 * Включено только при ARBIPAY_STORES_ENABLED=true (на dev/prod — GitHub variable, её
 * прокидывают deploy-dev.yml / deploy.yml). Локально не включать: локальная база занимала бы
 * коды точек (`la` + id события) в настоящем мерчанте.
 */
@Injectable()
export class ArbiPayStoresService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ArbiPayStoresService.name);
  private readonly serviceUrl: string;
  private readonly serviceHost: string;
  private readonly clientKey: string;
  private readonly apiSecret: string;
  private readonly enabled: boolean;
  /** Одновременные вызовы по одному событию делят одну попытку. */
  private readonly inFlight = new Map<number, Promise<string | null>>();

  constructor(private readonly config: ConfigService) {
    this.serviceUrl = this.config
      .get<string>('PAYMENT_SERVICE_URL', '')
      .trim()
      .replace(/\/+$/, '');
    this.serviceHost = this.hostOf(this.serviceUrl);
    this.clientKey = this.config.get<string>('PAYMENT_CLIENT_KEY', '').trim();
    this.apiSecret = this.config.get<string>('PAYMENT_API_SECRET', '').trim();
    this.enabled =
      this.config.get<string>('ARBIPAY_STORES_ENABLED', '').trim().toLowerCase() === 'true' &&
      Boolean(this.serviceHost && this.clientKey && this.apiSecret);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  onApplicationBootstrap(): void {
    if (this.enabled) {
      this.logger.log(`ARBIPAY stores enabled (via ${this.serviceUrl})`);
      return;
    }
    this.logger.log('ARBIPAY stores disabled (ARBIPAY_STORES_ENABLED is not "true", or PAYMENT_* env missing)');
  }

  private get eventModel(): mongoose.Model<IEvent> {
    return (
      (mongoose.models.Event as mongoose.Model<IEvent>) ??
      mongoose.model<IEvent>('Event', EventSchema)
    );
  }

  private get storeModel(): mongoose.Model<IEventArbiPayStore> {
    return eventArbiPayStoreModel();
  }

  /**
   * Код точки события, при необходимости создав её. Никогда не бросает: `null`
   * значит «точки нет», и вызывающий продолжает без неё.
   */
  async ensureStoreForEvent(eventId: number): Promise<string | null> {
    if (!this.enabled) return null;
    const running = this.inFlight.get(eventId);
    if (running) return running;
    const task = this.resolveStoreForEvent(eventId)
      .catch((error: unknown) => {
        this.logger.error(
          `ARBIPAY store for event ${eventId} not resolved: ${this.describe(error)}`,
        );
        return null;
      })
      .finally(() => this.inFlight.delete(eventId));
    this.inFlight.set(eventId, task);
    return task;
  }

  private get mockOrderModel(): mongoose.Model<IMockOrder> {
    return (
      (mongoose.models.MockOrder as mongoose.Model<IMockOrder>) ??
      mongoose.model<IMockOrder>('MockOrder', MockOrderSchema)
    );
  }

  /** Состояние точки события для админки (только чтение). */
  async getAdminState(eventId: number): Promise<AdminArbiPayStoreState> {
    const event = (await this.eventModel
      .findOne({ id: eventId })
      .select({ id: 1, status: 1 })
      .lean()
      .exec()) as Pick<IEvent, 'id' | 'status'> | null;
    if (!event) throw new NotFoundException('Event not found');

    const row = await this.storeModel
      .findOne({ eventId, serviceHost: this.serviceHost })
      .lean()
      .exec();

    const store = row
      ? {
          status: row.status,
          code: row.code,
          name: row.name,
          storeId: row.storeId ?? null,
          currency: row.currency ?? null,
          attempts: row.attempts ?? 0,
          lastError: row.lastError ?? null,
          lastAttemptAt: row.lastAttemptAt ?? null,
          activatedAt: row.activatedAt ?? null,
        }
      : null;

    const ineligibleReason: AdminArbiPayStoreIneligibleReason | null =
      MANUAL_STORE_EVENT_STATUSES.has(event.status)
        ? null
        : event.status === 'COMPLETED' || event.status === 'CANCELLED'
          ? 'sales_finished'
          : 'not_published';

    // Оплачено через ARBI Pay — то же правило провайдера, что у финансов (RUB/USDT/KZT и карта/PromptPay).
    const paidFilter: mongoose.FilterQuery<IMockOrder> = {
      event: eventId,
      status: 'paid',
      $expr: { $eq: [financeProviderExpr(), 'arbiPay'] },
    };
    // Граница — активация точки; у точек, созданных до появи activatedAt, её заменяет последняя попытка.
    const activeSince = store?.status === 'active' ? store.activatedAt ?? store.lastAttemptAt : null;
    if (activeSince) {
      paidFilter.createdAt = { $lt: activeSince };
    }
    const paidOrdersOutsideStore = await this.mockOrderModel.countDocuments(paidFilter).exec();

    return {
      enabled: this.enabled,
      eventId,
      eventStatus: event.status,
      eligible: this.enabled && ineligibleReason == null && store?.status !== 'active',
      ineligibleReason,
      expectedCode: arbiPayStoreCodeForEvent(eventId),
      store,
      paidOrdersOutsideStore,
    };
  }

  /**
   * Ручное создание точки админом — для событий, опубликованных до включения модуля, и
   * повтор для точек в conflict/failed/pending. Статистика событий с уже прошедшими
   * оплатами разойдётся с кабинетом ARBIPAY: об этом админку предупреждает карточка.
   */
  async createStoreManually(eventId: number): Promise<AdminArbiPayStoreState> {
    if (!this.enabled) {
      throw new ServiceUnavailableException('arbipay_stores_disabled');
    }
    const before = await this.getAdminState(eventId);
    if (before.store?.status === 'active') return before;
    if (before.ineligibleReason) {
      throw new BadRequestException(`arbipay_store_${before.ineligibleReason}`);
    }

    // conflict/failed крон не трогает — ручной запуск снимает этот запрет и счётчик попыток.
    if (before.store) {
      await this.storeModel
        .updateOne(
          { eventId, serviceHost: this.serviceHost, status: { $ne: 'active' } },
          { $set: { status: 'pending', attempts: 0, lastError: null } },
        )
        .exec();
    }
    this.logger.log(`Event ${eventId}: ARBIPAY store requested manually by admin`);
    await this.ensureStoreForEvent(eventId);
    return this.getAdminState(eventId);
  }

  /**
   * Код точки события для оплаты через ARBI Pay — любой: SBP/USDT/KZT и карта/PromptPay (THB).
   * Только чтение реестра: точку заводит публикация события (и крон), оформление заказа её не
   * создаёт и не ждёт. Нет кода (модуль выключен, событие опубликовано до модуля, создание не
   * удалось) — `null`, и платёж уходит в общую точку клиента, как раньше. Предупреждение в лог —
   * только когда точку заводили, но она не активна: у событий, опубликованных до модуля, это норма.
   * Никогда не бросает: сбой чтения реестра не должен ронять оформление заказа.
   */
  async storeCodeForPayment(eventId: number, orderId: number): Promise<string | null> {
    if (!this.enabled) return null;
    const row = await this.storeModel
      .findOne({ eventId, serviceHost: this.serviceHost })
      .select({ code: 1, status: 1 })
      .lean()
      .exec()
      .catch((error: unknown) => {
        this.logger.warn(`Order ${orderId}: ARBIPAY store lookup failed, paying without storeCode: ${this.describe(error)}`);
        return null;
      });
    if (row?.status === 'active') return row.code;
    if (row) {
      this.logger.warn(
        `Order ${orderId}: ARBIPAY store of event ${eventId} is ${row.status}, paying without storeCode`,
      );
    }
    return null;
  }

  private async resolveStoreForEvent(eventId: number): Promise<string | null> {
    const existing = await this.storeModel
      .findOne({ eventId, serviceHost: this.serviceHost })
      .exec();
    if (existing?.status === 'active') return existing.code;
    // conflict/failed — решение за человеком: сам себя такой случай не исправит.
    if (existing && existing.status !== 'pending') return null;

    const event = (await this.eventModel
      .findOne({ id: eventId })
      .select({ id: 1, title: 1, status: 1 })
      .lean()
      .exec()) as Pick<IEvent, 'id' | 'title' | 'status'> | null;
    if (!event) return null;

    const code = arbiPayStoreCodeForEvent(event.id);
    if (!code) {
      this.logger.error(`Event ${event.id}: ARBIPAY store code does not fit 12 letters`);
      return null;
    }
    const name = this.storeName(event);

    // Отметка о попытке до запроса: повтор пойдёт по этой же строке, а не создаст новую.
    const row = await this.storeModel
      .findOneAndUpdate(
        { eventId, serviceHost: this.serviceHost },
        {
          $setOnInsert: { eventId, serviceHost: this.serviceHost, code, status: 'pending' },
          $set: { name, lastAttemptAt: new Date() },
          $inc: { attempts: 1 },
        },
        { new: true, upsert: true },
      )
      .exec();

    const outcome = await this.createStore(code, name);
    // Неудача не затирает точку, которую успела активировать параллельная попытка (крон второго инстанса).
    await this.storeModel
      .updateOne(
        outcome.status === 'active' ? { _id: row._id } : { _id: row._id, status: { $ne: 'active' } },
        {
          $set: {
            status: outcome.status,
            code: outcome.code,
            storeId: outcome.storeId,
            currency: outcome.currency,
            lastError: outcome.error ? this.preview(outcome.error) : null,
          },
        },
      )
      .exec();

    if (outcome.status === 'active') {
      // Первая активация — граница «до/после» для оплат события.
      await this.storeModel
        .updateOne({ _id: row._id, activatedAt: null }, { $set: { activatedAt: new Date() } })
        .exec();
      this.logger.log(
        `Event ${eventId}: ARBIPAY store "${outcome.code}" ready (id=${outcome.storeId ?? '—'}, currency=${outcome.currency ?? '—'})`,
      );
      return outcome.code;
    }
    this.logger.warn(
      `Event ${eventId}: ARBIPAY store "${code}" not created (${outcome.status}): ${outcome.error ?? 'no details'}`,
    );
    return null;
  }

  /** Запрос на создание точки в микросервис. Ошибки не бросает — возвращает исход. */
  private async createStore(code: string, name: string): Promise<EnsureOutcome> {
    const fail = (status: EventArbiPayStoreStatus, error: string): EnsureOutcome => ({
      status,
      code,
      storeId: null,
      currency: null,
      error,
    });

    let response: Response;
    let text: string;
    try {
      response = await fetch(`${this.serviceUrl}/stores/arbi`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Client-Key': this.clientKey,
          'X-Api-Secret': this.apiSecret,
        },
        body: JSON.stringify({ name, slug: code }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      text = await response.text();
    } catch (error) {
      // Сеть/таймаут — повторяемо.
      return fail('pending', this.describe(error));
    }

    if (response.status === 200 || response.status === 201) {
      let answer: StoreApiAnswer | null = null;
      try {
        answer = JSON.parse(text) as StoreApiAnswer;
      } catch {
        return fail('pending', `unexpected ${response.status} answer: ${this.preview(text)}`);
      }
      const answeredCode = answer?.store?.code;
      if (typeof answeredCode !== 'string' || answeredCode.toLowerCase() !== code) {
        return fail(
          'pending',
          `answer has store code "${String(answeredCode)}" instead of "${code}"`,
        );
      }
      return {
        status: 'active',
        code: answeredCode.toLowerCase(),
        storeId: typeof answer?.store?.id === 'string' ? answer.store.id : null,
        currency:
          typeof answer?.store?.effectiveCurrency === 'string'
            ? answer.store.effectiveCurrency
            : null,
        error: null,
      };
    }

    // 409 — код занят чужой точкой мерчанта: сам не разрешится, нужен человек.
    if (response.status === 409) return fail('conflict', this.preview(text));
    // 503 — микросервис/ARBIPAY недоступны или исход неизвестен: повторяемо.
    if (response.status === 503) return fail('pending', this.preview(text));
    // 5xx микросервиса — тоже повторяемо.
    if (response.status >= 500) return fail('pending', `${response.status} ${this.preview(text)}`);
    // 4xx (ключи, валидация, отказ ARBIPAY) — определённый отказ.
    return fail('failed', `${response.status} ${this.preview(text)}`);
  }

  /**
   * Добирает точки, чьё создание не завершилось (микросервис или ARBIPAY были
   * недоступны, процесс перезапустился на полпути). `conflict` и `failed` не трогает.
   */
  @Cron('*/10 * * * *')
  async retryPendingStores(): Promise<void> {
    if (!this.enabled) return;
    const deadline = new Date(Date.now() - RETRY_AFTER_MS);
    const pending = await this.storeModel
      .find({
        serviceHost: this.serviceHost,
        status: 'pending',
        attempts: { $lt: MAX_ATTEMPTS },
        $or: [{ lastAttemptAt: null }, { lastAttemptAt: { $lte: deadline } }],
      })
      .select({ eventId: 1 })
      .sort({ lastAttemptAt: 1 })
      .limit(RETRY_BATCH)
      .lean()
      .exec();
    if (!pending.length) return;
    this.logger.log(`ARBIPAY stores: retrying ${pending.length} unfinished store(s)`);
    for (const row of pending) {
      await this.ensureStoreForEvent(row.eventId);
    }
  }

  private storeName(event: Pick<IEvent, 'id' | 'title'>): string {
    const title = [event.title?.en, event.title?.ru, event.title?.th]
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .find((value) => value.length > 0);
    return `#${event.id} ${title ?? 'Lotus Arena'}`.slice(0, STORE_NAME_MAX_LENGTH);
  }

  private hostOf(url: string): string {
    try {
      return new URL(url).host.toLowerCase();
    } catch {
      return '';
    }
  }

  private preview(text: string): string {
    return (text ?? '').replace(/\s+/g, ' ').slice(0, ERROR_PREVIEW_CHARS);
  }

  private describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
