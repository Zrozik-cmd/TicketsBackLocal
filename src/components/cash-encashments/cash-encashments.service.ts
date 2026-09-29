import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import mongoose from 'mongoose';
import { ICT_OFFSET_MS } from '../events/utils/ict-date.util';
import { ILocalizedText } from '../events/schemas/event.schema';
import { CashOrdersActor } from '../cash-orders/guards/cash-orders-access.guard';
import { isLocationRepeaterId } from '../content-cms/constants/location-card.constants';
import { CmsPageSchema, ICmsPage } from '../content-cms/schemas/cms-page.schema';
import { CmsRepeaterItem } from '../content-cms/types/cms.types';
import {
  CashierArbiSchema,
  ICashierArbi,
} from '../cashier-arbi/schemas/cashier-arbi.schema';
import {
  IMockOrder,
  MockOrderSchema,
} from '../mock-orders/schemas/mock-order.schema';
import { AdminSchema, IAdmin } from '../admin/schemas/admin.schema';
import { NotificationService } from '../../services/NotificationService/notification.service';
import {
  CashTillAlertSchema,
  ICashTillAlert,
} from './schemas/cash-till-alert.schema';
import {
  CASH_SETTINGS_KEY,
  CashSettingsSchema,
  ICashSettings,
} from './schemas/cash-settings.schema';
import { UpdateCashSettingsDto } from './dto/update-cash-settings.dto';
import { resolveTillAlertRecipients } from './utils/till-alert-recipients.util';
import { CreateAdjustmentDto } from './dto/create-adjustment.dto';
import { CreateCollectorDto } from './dto/create-collector.dto';
import { CreateEncashmentDto } from './dto/create-encashment.dto';
import { EncashmentsQueryDto } from './dto/encashments-query.dto';
import { CashSeriesQueryDto } from './dto/cash-series-query.dto';
import { PosStatsPeriod, PosStatsQueryDto } from './dto/pos-stats-query.dto';
import { ScansQueryDto } from './dto/scans-query.dto';
import { ResetTillDto } from './dto/reset-till.dto';
import {
  CashCollectorSchema,
  ICashCollector,
} from './schemas/cash-collector.schema';
import {
  CashEncashmentSchema,
  ICashEncashment,
} from './schemas/cash-encashment.schema';
import {
  CashLedgerActorRole,
  CashLedgerEntrySchema,
  ICashLedgerEntry,
} from './schemas/cash-ledger-entry.schema';
import {
  CashScanEventSchema,
  CashScanSource,
  ICashScanEvent,
} from './schemas/cash-scan-event.schema';

const DAY_MS = 24 * 60 * 60 * 1000;
const CASH_CURRENCY = 'THB';

/**
 * Деньги наружу и в сравнениях — ровно до сатанга. $sum по double копит
 * хвосты (109.14 + 109.14 + 709.41 = 927.6899999999999), и «сдать всю кассу»
 * на показанные 927.69 падало как превышение. Хранимые строки не трогаем —
 * округляем только посчитанное.
 */
const roundMoney = (value: number): number => Math.round(value * 100) / 100;

/** Выручка кассира — всегда подтверждённые заказы наличными. */
const CASH_PAID_MATCH = { paymentMethod: 'CASH', status: 'paid' } as const;

/**
 * Момент, которым заказ попадает в окно отчёта.
 *
 * Обычно это подтверждение оплаты, но у заказов, оформленных до появления
 * кассового контура, отметки нет. Без отката на дату создания такой заказ
 * молча выпадал из всех графиков (пустой ключ корзины ни с чем не совпадает),
 * оставаясь при этом в сводке по точкам — и суммы двух экранов расходились.
 */
const CASH_PAID_AT = { $ifNull: ['$paymentConfirmedAt', '$createdAt'] } as const;

/** Тот же откат для $match, где выражения требуют $expr. */
const cashPaidAtAtLeast = (since: number) => ({
  $expr: { $gte: [CASH_PAID_AT, new Date(since)] },
});

/** Шаг уведомления админов о размере кассы: каждые 50 000 THB. */
export const CASH_TILL_ALERT_STEP = 50_000;

/*
 * Получателей письма о пороге задаёт админ на странице «Статистика по точкам»
 * (коллекция cash_settings). Пока список пуст, письмо не уходит никому.
 */

type PeriodTotals = { amount: number; orders: number; tickets: number };

/** Окна отчётов: «сегодня» — календарные сутки ICT, остальные — скользящие. */
type PeriodKey = 'today' | 'days7' | 'days30' | 'days180' | 'days365' | 'all';

type SummaryAggRow = { _id: null; amount: number; orders: number; tickets: number };

/** Шаг сетки графиков. */
type SeriesGranularity = 'hour' | 'day' | 'month';

/** Достройка ключа корзины до разбираемой даты. */
const SERIES_KEY_SUFFIX: Record<SeriesGranularity, string> = {
  hour: ':00:00.000Z',
  day: 'T00:00:00.000Z',
  month: '-01T00:00:00.000Z',
};

const HOUR_MS = 60 * 60 * 1000;

/**
 * Субъект кассы. Обычно кассир; для админа без cashierId — общая касса
 * админки (id 0): все заказы, подтверждённые из панели, лежат в одном пуле.
 */
type StatsTarget = {
  id: number;
  email: string;
  posLocation: string;
  isActive: boolean;
};

const ADMIN_TARGET: StatsTarget = {
  id: 0,
  email: 'admin',
  posLocation: 'Admin',
  isActive: true,
};

/** Автор движения — кто именно нажал кнопку. */
type LedgerActor = {
  email: string;
  id: number;
  role: CashLedgerActorRole;
};

/** Начало ICT-суток (UTC+7, без DST), в которые попадает `ms`, как UTC-таймстамп. */
function ictDayStartMs(ms: number): number {
  const day = new Date(ms + ICT_OFFSET_MS).toISOString().slice(0, 10);
  return Date.parse(`${day}T00:00:00.000Z`) - ICT_OFFSET_MS;
}

/** Начало ICT-суток для строки YYYY-MM-DD. */
function ictDayStringStartMs(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`) - ICT_OFFSET_MS;
}

@Injectable()
export class CashEncashmentsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(CashEncashmentsService.name);

  constructor(private readonly notificationService: NotificationService) {}

  private get tillAlertModel(): mongoose.Model<ICashTillAlert> {
    return (
      (mongoose.models.CashTillAlert as mongoose.Model<ICashTillAlert>) ??
      mongoose.model<ICashTillAlert>('CashTillAlert', CashTillAlertSchema)
    );
  }

  private get cashSettingsModel(): mongoose.Model<ICashSettings> {
    return (
      (mongoose.models.CashSettings as mongoose.Model<ICashSettings>) ??
      mongoose.model<ICashSettings>('CashSettings', CashSettingsSchema)
    );
  }

  private get ledgerModel(): mongoose.Model<ICashLedgerEntry> {
    return (
      (mongoose.models.CashLedgerEntry as mongoose.Model<ICashLedgerEntry>) ??
      mongoose.model<ICashLedgerEntry>('CashLedgerEntry', CashLedgerEntrySchema)
    );
  }

  /** Старое хранилище инкассаций: после миграции в журнал — только архив. */
  private get legacyEncashmentModel(): mongoose.Model<ICashEncashment> {
    return (
      (mongoose.models.CashEncashment as mongoose.Model<ICashEncashment>) ??
      mongoose.model<ICashEncashment>('CashEncashment', CashEncashmentSchema)
    );
  }

  private get collectorModel(): mongoose.Model<ICashCollector> {
    return (
      (mongoose.models.CashCollector as mongoose.Model<ICashCollector>) ??
      mongoose.model<ICashCollector>('CashCollector', CashCollectorSchema)
    );
  }

  private get cashierModel(): mongoose.Model<ICashierArbi> {
    return (
      (mongoose.models.CashierArbi as mongoose.Model<ICashierArbi>) ??
      mongoose.model<ICashierArbi>('CashierArbi', CashierArbiSchema)
    );
  }

  private get mockOrderModel(): mongoose.Model<IMockOrder> {
    return (
      (mongoose.models.MockOrder as mongoose.Model<IMockOrder>) ??
      mongoose.model<IMockOrder>('MockOrder', MockOrderSchema)
    );
  }

  private get scanEventModel(): mongoose.Model<ICashScanEvent> {
    return (
      (mongoose.models.CashScanEvent as mongoose.Model<ICashScanEvent>) ??
      mongoose.model<ICashScanEvent>('CashScanEvent', CashScanEventSchema)
    );
  }

  private get cmsPageModel(): mongoose.Model<ICmsPage> {
    return (
      (mongoose.models.ContentCmsPage as mongoose.Model<ICmsPage>) ??
      mongoose.model<ICmsPage>('ContentCmsPage', CmsPageSchema)
    );
  }

  private get adminModel(): mongoose.Model<IAdmin> {
    return (
      (mongoose.models.Admin as mongoose.Model<IAdmin>) ??
      mongoose.model<IAdmin>('Admin', AdminSchema)
    );
  }

  /**
   * Кто выполняет операцию. Для админа поднимаем его настоящий email из БД:
   * в журнале должно стоять имя конкретного человека, а не роль — по этим
   * записям потом разбираются, куда делись деньги.
   */
  private async resolveActor(actor: CashOrdersActor): Promise<LedgerActor> {
    if (actor.type === 'CashierArbi') {
      return { email: actor.email, id: Number(actor.cashierId), role: 'CashierArbi' };
    }
    const adminId = Number(actor.adminId);
    const admin = Number.isInteger(adminId)
      ? await this.adminModel.findOne({ id: adminId }).select('email').lean().exec()
      : null;
    return {
      email: admin?.email ?? `admin#${actor.adminId}`,
      id: Number.isInteger(adminId) ? adminId : 0,
      role: 'Admin',
    };
  }

  /* ------------------------------------------------------------------ */
  /* Миграция на журнал: один раз, идемпотентно                          */
  /* ------------------------------------------------------------------ */

  async onApplicationBootstrap(): Promise<void> {
    try {
      await mongoose.connection.asPromise();
      await this.backfillOrderCashierIds();
      await this.seedLedgerFromHistory();
    } catch (error) {
      this.logger.error(
        `Cash ledger migration failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Деньги ключуются по неизменяемому cashierId, а не по email: смена email
   * кассира больше не осиротляет его заказы. Старые записи дополняются здесь.
   */
  private async backfillOrderCashierIds(): Promise<void> {
    const cashiers = await this.cashierModel.find().select('id email').lean().exec();
    let updated = 0;
    for (const cashier of cashiers) {
      const res = await this.mockOrderModel
        .updateMany(
          { paymentMethod: 'CASH', cashierEmail: cashier.email, cashierId: { $exists: false } },
          { $set: { cashierId: cashier.id } },
        )
        .exec();
      updated += res.modifiedCount ?? 0;
    }
    const adminRes = await this.mockOrderModel
      .updateMany(
        { paymentMethod: 'CASH', cashierEmail: 'admin', cashierId: { $exists: false } },
        { $set: { cashierId: 0 } },
      )
      .exec();
    updated += adminRes.modifiedCount ?? 0;
    if (updated > 0) {
      this.logger.log(`Cash ledger: backfilled cashierId on ${updated} order(s)`);
    }
  }

  /**
   * Перенос истории в журнал. Идемпотентно ПО КАЖДОМУ ЭЛЕМЕНТУ и потому
   * самовосстанавливается: гонка двух процессов или падение на середине не
   * оставляют кассу кривой — следующий запуск только заполняет пробелы.
   *
   * - Старая инкассация импортируется один раз: помечается на исходном
   *   документе и дополнительно сверяется по точной сигнатуре.
   * - Opening владельца — сумма его оплаченных CASH-заказов, у которых ещё
   *   НЕТ sale-строки; вставляется только если opening-строки ещё нет.
   *   В системе, живущей с журналом с первого дня, обе величины нулевые.
   */
  private async seedLedgerFromHistory(): Promise<void> {
    this.logger.log('Cash ledger: reconciliation pass started');

    let imported = 0;
    const legacy = await this.legacyEncashmentModel
      .find({ migratedToLedgerAt: { $exists: false } })
      .lean()
      .exec();
    for (const row of legacy) {
      const duplicate = await this.ledgerModel
        .exists({
          type: 'encashment',
          cashierId: row.cashierId,
          amount: -Math.abs(row.amount),
          collectorName: row.collectorName,
          createdAt: row.createdAt,
        })
        .exec();
      if (!duplicate) {
        // .save() — autoinc-`id` назначается save-хуком; createdAt сохраняем исходный.
        await new this.ledgerModel({
          cashierId: row.cashierId,
          cashierEmail: row.cashierEmail,
          type: 'encashment',
          amount: -Math.abs(row.amount),
          currency: row.currency ?? CASH_CURRENCY,
          collectorName: row.collectorName,
          createdBy: row.cashierEmail,
          createdAt: row.createdAt,
        }).save();
        imported += 1;
      }
      await this.legacyEncashmentModel
        .updateOne({ _id: row._id }, { $set: { migratedToLedgerAt: new Date() } })
        .exec();
    }

    const cashiers = await this.cashierModel.find().lean().exec();
    const targets: StatsTarget[] = [
      ADMIN_TARGET,
      ...cashiers.map((cashier) => ({
        id: cashier.id,
        email: cashier.email,
        posLocation: cashier.posLocation,
        isActive: cashier.isActive !== false,
      })),
    ];

    let openings = 0;
    for (const target of targets) {
      const hasOpening = await this.ledgerModel
        .exists({ cashierId: target.id, type: 'opening' })
        .exec();
      if (hasOpening) continue;

      const saleOrderIds = await this.ledgerModel
        .distinct('orderId', { cashierId: target.id, type: 'sale' })
        .exec();
      const rows = await this.mockOrderModel.aggregate<{ _id: null; amount: number }>([
        {
          $match: {
            ...CASH_PAID_MATCH,
            cashierId: target.id,
            id: { $nin: saleOrderIds },
          },
        },
        { $group: { _id: null, amount: { $sum: '$total_price' } } },
      ]);
      const earned = roundMoney(rows[0]?.amount ?? 0);
      if (earned === 0) continue;

      await new this.ledgerModel({
        cashierId: target.id,
        cashierEmail: target.email,
        type: 'opening',
        amount: earned,
        currency: CASH_CURRENCY,
        note: 'Выручка до внедрения журнала движений',
        createdBy: 'system',
      }).save();
      openings += 1;
    }

    this.logger.log(
      `Cash ledger: reconciliation done — ${openings} opening row(s), ${imported} legacy encashment(s) imported`,
    );
  }

  /* ------------------------------------------------------------------ */
  /* Субъект                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Кассир всегда работает со своими данными. Админ без cashierId получает
   * общую кассу админки, с cashierId — кассира. Это единственная точка выбора
   * субъекта — обойти её из контроллера нельзя.
   */
  private async resolveTarget(
    actor: CashOrdersActor,
    cashierIdParam?: number,
  ): Promise<StatsTarget> {
    if (actor.type === 'Admin' && cashierIdParam == null) {
      return ADMIN_TARGET;
    }
    const cashierId =
      actor.type === 'CashierArbi' ? Number(actor.cashierId) : cashierIdParam;
    if (cashierId == null || !Number.isInteger(cashierId) || cashierId < 1) {
      throw new BadRequestException('cashier_id_required');
    }
    const cashier = await this.cashierModel
      .findOne({ id: cashierId })
      .lean()
      .exec();
    if (!cashier) {
      throw new NotFoundException('cashier_arbi_not_found');
    }
    return {
      id: cashier.id,
      email: cashier.email,
      posLocation: cashier.posLocation,
      isActive: cashier.isActive !== false,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Выручка (из заказов) и касса (из журнала)                           */
  /* ------------------------------------------------------------------ */

  private async earnedTotals(
    cashierId: number,
  ): Promise<{ today: PeriodTotals; days7: PeriodTotals; days30: PeriodTotals; all: PeriodTotals }> {
    const now = Date.now();
    const todayStart = new Date(ictDayStartMs(now));
    const days7Start = new Date(now - 7 * DAY_MS);
    const days30Start = new Date(now - 30 * DAY_MS);

    const group = {
      $group: {
        _id: null as null,
        amount: { $sum: '$total_price' },
        orders: { $sum: 1 },
        // Билеты — сумма count по строкам заказа, а не число заказов.
        tickets: {
          $sum: {
            $reduce: {
              input: { $ifNull: ['$tickets', []] },
              initialValue: 0,
              in: { $add: ['$$value', { $ifNull: ['$$this.count', 0] }] },
            },
          },
        },
      },
    };

    const [facetResult] = await this.mockOrderModel.aggregate<{
      today: SummaryAggRow[];
      days7: SummaryAggRow[];
      days30: SummaryAggRow[];
      all: SummaryAggRow[];
    }>([
      { $match: { ...CASH_PAID_MATCH, cashierId } },
      {
        $facet: {
          today: [{ $match: { $expr: { $gte: [CASH_PAID_AT, todayStart] } } }, group],
          days7: [{ $match: { $expr: { $gte: [CASH_PAID_AT, days7Start] } } }, group],
          days30: [{ $match: { $expr: { $gte: [CASH_PAID_AT, days30Start] } } }, group],
          all: [group],
        },
      },
    ]);

    const pick = (rows?: SummaryAggRow[]): PeriodTotals => ({
      amount: roundMoney(rows?.[0]?.amount ?? 0),
      orders: rows?.[0]?.orders ?? 0,
      tickets: rows?.[0]?.tickets ?? 0,
    });

    return {
      today: pick(facetResult?.today),
      days7: pick(facetResult?.days7),
      days30: pick(facetResult?.days30),
      all: pick(facetResult?.all),
    };
  }

  /**
   * Начало периода как UTC-таймстамп; null — «всё время».
   * «Сегодня» — календарные сутки ICT, 7/30 дней — скользящие окна:
   * та же семантика, что у выручки в сводке.
   */
  private periodStart(period: PeriodKey): number | null {
    const now = Date.now();
    if (period === 'today') return ictDayStartMs(now);
    if (period === 'days7') return now - 7 * DAY_MS;
    if (period === 'days30') return now - 30 * DAY_MS;
    if (period === 'days180') return now - 180 * DAY_MS;
    if (period === 'days365') return now - 365 * DAY_MS;
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* Статистика по точкам                                                */
  /* ------------------------------------------------------------------ */

  /**
   * Канонический справочник точек из CMS. Одна и та же точка хранится в
   * заказах на языке покупателя, а у кассира — на языке админа, поэтому
   * группировать по строке нельзя: собираем все написания карточки.
   */
  private async loadPosCatalog(): Promise<
    Array<{ id: string; title: ILocalizedText; aliases: string[] }>
  > {
    const pages = await this.cmsPageModel
      .find({ publication: 'published' })
      .select({ sections: 1 })
      .lean()
      .exec();

    const catalog: Array<{ id: string; title: ILocalizedText; aliases: string[] }> = [];
    const seen = new Set<string>();

    for (const page of pages) {
      for (const section of page.sections ?? []) {
        if (!section.visible) continue;
        for (const field of section.fields ?? []) {
          if (field.type !== 'repeater' || !isLocationRepeaterId(field.id)) continue;
          for (const item of field.items as CmsRepeaterItem[]) {
            if (item.showCard === false) continue;
            const id = item.unique_id ?? item.id;
            if (!id || seen.has(id)) continue;
            seen.add(id);

            const titleField = item.fields.find((candidate) => candidate.id === 'title');
            const localized: ILocalizedText =
              titleField &&
              (titleField.type === 'text' ||
                titleField.type === 'textarea' ||
                titleField.type === 'richText')
                ? {
                    en: titleField.value.en,
                    ru: titleField.value.ru,
                    th: titleField.value.th,
                  }
                : {};
            const aliases = [
              item.id,
              item.unique_id,
              item.title,
              localized.en,
              localized.ru,
              localized.th,
            ].filter((value): value is string => typeof value === 'string' && value.trim() !== '');

            catalog.push({ id, title: localized, aliases });
          }
        }
      }
    }
    return catalog;
  }

  /**
   * Сводка по точкам за период: выручка, чеки, билеты, касса и сданное
   * инкассаторам. Выручка считается по actualPos — по месту, где деньги
   * реально приняли, а не где клиент собирался платить.
   */
  async getPosStats(query: PosStatsQueryDto) {
    const period: PeriodKey = query.period ?? 'today';
    const since = this.periodStart(period);

    const orderMatch: Record<string, unknown> = { ...CASH_PAID_MATCH };
    if (since != null) Object.assign(orderMatch, cashPaidAtAtLeast(since));

    const [salesRows, cashiers, ledgerRows, catalog] = await Promise.all([
      this.mockOrderModel.aggregate<{
        _id: { pos: string | null; cashierId: number | null };
        revenue: number;
        orders: number;
        tickets: number;
        lastSaleAt: Date | null;
      }>([
        { $match: orderMatch },
        {
          $group: {
            // Кассир важнее строки: точку заказа определяем по тому, кто принял
            // деньги, и только для админских подтверждений — по названию.
            _id: { pos: '$actualPos', cashierId: '$cashierId' },
            revenue: { $sum: '$total_price' },
            orders: { $sum: 1 },
            tickets: {
              $sum: {
                $reduce: {
                  input: { $ifNull: ['$tickets', []] },
                  initialValue: 0,
                  in: { $add: ['$$value', { $ifNull: ['$$this.count', 0] }] },
                },
              },
            },
            lastSaleAt: { $max: CASH_PAID_AT },
          },
        },
      ]),
      this.cashierModel.find().select('id email posLocation posLocationUniqueId isActive').lean().exec(),
      this.ledgerModel.aggregate<{ _id: number; till: number; encashed: number }>([
        {
          $group: {
            _id: '$cashierId',
            till: { $sum: '$amount' },
            encashed: {
              $sum: { $cond: [{ $eq: ['$type', 'encashment'] }, '$amount', 0] },
            },
          },
        },
      ]),
      this.loadPosCatalog(),
    ]);

    const normalize = (value?: string | null) => value?.trim().toLocaleLowerCase() ?? '';
    /** Любое написание точки -> её канонический id. */
    const aliasToId = new Map<string, string>();
    for (const pos of catalog) {
      for (const alias of pos.aliases) aliasToId.set(normalize(alias), pos.id);
    }

    /**
     * Строка кассира внутри точки. Ключ — cashierId; 0 — подтверждения админа,
     * ADMIN_DETAIL_ID и LEGACY_DETAIL_ID держим отдельно, чтобы сумма строк
     * сходилась с итогом точки, а не «терялась» в разнице.
     */
    type CashierDetail = {
      cashierId: number;
      email: string;
      revenue: number;
      orders: number;
      tickets: number;
      lastSaleAt: Date | null;
      till: number;
      encashed: number;
      isActive: boolean;
      kind: 'cashier' | 'admin' | 'legacy';
    };
    type Bucket = {
      id: string;
      title: ILocalizedText;
      revenue: number;
      orders: number;
      tickets: number;
      lastSaleAt: Date | null;
      till: number;
      encashed: number;
      cashiers: number;
      activeCashiers: number;
      details: Map<number, CashierDetail>;
    };
    const buckets = new Map<string, Bucket>();
    const bucketOf = (id: string, title: ILocalizedText): Bucket => {
      let bucket = buckets.get(id);
      if (!bucket) {
        bucket = {
          id,
          title,
          revenue: 0,
          orders: 0,
          tickets: 0,
          lastSaleAt: null,
          till: 0,
          encashed: 0,
          cashiers: 0,
          activeCashiers: 0,
          details: new Map(),
        };
        buckets.set(id, bucket);
      }
      return bucket;
    };

    /** Подтверждения админа и заказы без кассира — свои строки, не «прочее». */
    const ADMIN_DETAIL_ID = 0;
    const LEGACY_DETAIL_ID = -1;
    const detailOf = (
      bucket: Bucket,
      cashierId: number,
      email: string,
      kind: CashierDetail['kind'],
    ): CashierDetail => {
      let detail = bucket.details.get(cashierId);
      if (!detail) {
        detail = {
          cashierId,
          email,
          revenue: 0,
          orders: 0,
          tickets: 0,
          lastSaleAt: null,
          till: 0,
          encashed: 0,
          isActive: true,
          kind,
        };
        bucket.details.set(cashierId, detail);
      }
      return detail;
    };

    // Точки из справочника показываем всегда, даже с нулевой выручкой.
    for (const pos of catalog) bucketOf(pos.id, pos.title);

    const UNKNOWN_ID = '__unknown__';
    const catalogIds = new Set(catalog.map((pos) => pos.id));

    /**
     * Точка кассира — по его карточке, а не по строке в заказе: у одной точки
     * накапливаются разные написания (перевод, переименование), и по тексту
     * часть выручки уезжала в «прочее».
     */
    const cashierPosId = new Map<number, string>();
    const cashierById = new Map(cashiers.map((cashier) => [cashier.id, cashier]));
    for (const cashier of cashiers) {
      const byUniqueId =
        cashier.posLocationUniqueId && catalogIds.has(cashier.posLocationUniqueId)
          ? cashier.posLocationUniqueId
          : undefined;
      const id = byUniqueId ?? aliasToId.get(normalize(cashier.posLocation));
      if (id) cashierPosId.set(cashier.id, id);
    }

    /** Точка, которой уже нет в CMS, показывается своим именем, а не «прочим». */
    const legacyBucketId = (name: string) => `legacy:${name.trim().toLocaleLowerCase()}`;

    for (const row of salesRows) {
      const cashierId = row._id.cashierId;
      const posName = row._id.pos;
      let id =
        cashierId != null && cashierId > 0 ? cashierPosId.get(cashierId) : undefined;
      if (!id) id = aliasToId.get(normalize(posName));
      if (!id) {
        id = posName?.trim() ? legacyBucketId(posName) : UNKNOWN_ID;
      }
      const fallbackTitle =
        id === UNKNOWN_ID
          ? { en: 'No point specified', ru: 'Точка не указана' }
          : id.startsWith('legacy:')
            ? { en: posName ?? '', ru: posName ?? '', th: posName ?? '' }
            : {};
      const bucket = bucketOf(id, fallbackTitle);
      bucket.revenue += row.revenue;
      bucket.orders += row.orders;
      bucket.tickets += row.tickets;
      if (row.lastSaleAt && (!bucket.lastSaleAt || row.lastSaleAt > bucket.lastSaleAt)) {
        bucket.lastSaleAt = row.lastSaleAt;
      }

      const detailId =
        cashierId == null
          ? LEGACY_DETAIL_ID
          : cashierId > 0
            ? cashierId
            : ADMIN_DETAIL_ID;
      const detail = detailOf(
        bucket,
        detailId,
        detailId === ADMIN_DETAIL_ID
          ? 'admin'
          : detailId === LEGACY_DETAIL_ID
            ? ''
            : (cashierById.get(cashierId as number)?.email ?? ''),
        detailId === ADMIN_DETAIL_ID
          ? 'admin'
          : detailId === LEGACY_DETAIL_ID
            ? 'legacy'
            : 'cashier',
      );
      /*
       * Флаг активности берём из карточки прямо здесь: если точка кассира не
       * резолвится (карточку переименовали/удалили из CMS), цикл по кассирам
       * положит его в ДРУГОЙ бакет и правка isActive туда не дотянется —
       * деактивированный кассир показывался бы активным рядом со своей выручкой.
       */
      if (detailId > 0) {
        const card = cashierById.get(detailId);
        if (card) detail.isActive = card.isActive !== false;
      }
      detail.revenue += row.revenue;
      detail.orders += row.orders;
      detail.tickets += row.tickets;
      if (row.lastSaleAt && (!detail.lastSaleAt || row.lastSaleAt > detail.lastSaleAt)) {
        detail.lastSaleAt = row.lastSaleAt;
      }
    }

    const ledgerByCashier = new Map(ledgerRows.map((row) => [row._id, row]));
    for (const cashier of cashiers) {
      const id = cashierPosId.get(cashier.id) ?? UNKNOWN_ID;
      const bucket = bucketOf(
        id,
        id === UNKNOWN_ID ? { en: 'No point specified', ru: 'Точка не указана' } : {},
      );
      bucket.cashiers += 1;
      if (cashier.isActive !== false) bucket.activeCashiers += 1;
      const ledger = ledgerByCashier.get(cashier.id);
      bucket.till += ledger?.till ?? 0;
      bucket.encashed += -(ledger?.encashed ?? 0);

      // Кассир точки виден в раскрытии даже без продаж за период: нулевая
      // выручка при непустой кассе — это и есть повод посмотреть.
      const detail = detailOf(bucket, cashier.id, cashier.email, 'cashier');
      detail.email = cashier.email;
      detail.isActive = cashier.isActive !== false;
      detail.till = ledger?.till ?? 0;
      detail.encashed = -(ledger?.encashed ?? 0);
    }

    const adminLedger = ledgerByCashier.get(0);
    const rows = Array.from(buckets.values())
      .map((bucket) => ({
        id: bucket.id,
        title: bucket.title,
        revenue: roundMoney(bucket.revenue),
        orders: bucket.orders,
        tickets: bucket.tickets,
        /** Средний чек за период — сразу видно, где берут дороже. */
        avg_check: bucket.orders > 0 ? roundMoney(bucket.revenue / bucket.orders) : 0,
        till: roundMoney(bucket.till),
        encashed: roundMoney(bucket.encashed),
        cashiers: bucket.cashiers,
        active_cashiers: bucket.activeCashiers,
        last_sale_at: bucket.lastSaleAt ? new Date(bucket.lastSaleAt).toISOString() : null,
        /** Раскрытие точки: по кассиру — выручка за период и касса на сейчас. */
        cashiers_detail: Array.from(bucket.details.values())
          .map((detail) => ({
            cashier_id: detail.cashierId,
            email: detail.email,
            kind: detail.kind,
            revenue: roundMoney(detail.revenue),
            orders: detail.orders,
            tickets: detail.tickets,
            avg_check: detail.orders > 0 ? roundMoney(detail.revenue / detail.orders) : 0,
            till: roundMoney(detail.till),
            encashed: roundMoney(detail.encashed),
            is_active: detail.isActive,
            last_sale_at: detail.lastSaleAt
              ? new Date(detail.lastSaleAt).toISOString()
              : null,
          }))
          .sort((a, b) => b.revenue - a.revenue || b.till - a.till),
      }))
      .sort((a, b) => b.revenue - a.revenue);

    const totals = rows.reduce(
      (acc, row) => ({
        revenue: acc.revenue + row.revenue,
        orders: acc.orders + row.orders,
        tickets: acc.tickets + row.tickets,
        till: acc.till + row.till,
        encashed: acc.encashed + row.encashed,
        cashiers: acc.cashiers + row.cashiers,
      }),
      { revenue: 0, orders: 0, tickets: 0, till: 0, encashed: 0, cashiers: 0 },
    );

    return {
      currency: CASH_CURRENCY,
      period,
      rows,
      totals: {
        ...totals,
        revenue: roundMoney(totals.revenue),
        till: roundMoney(totals.till),
        encashed: roundMoney(totals.encashed),
        avg_check: totals.orders > 0 ? roundMoney(totals.revenue / totals.orders) : 0,
        /** Касса админки к точке не привязана — показываем отдельной строкой. */
        admin_till: roundMoney(adminLedger?.till ?? 0),
        admin_encashed: roundMoney(-(adminLedger?.encashed ?? 0)),
      },
    };
  }

  /** Касса владельца — сумма подписанных строк журнала, и ничего больше. */
  private async tillBalance(cashierId: number): Promise<number> {
    const rows = await this.ledgerModel.aggregate<{ _id: null; amount: number }>([
      { $match: { cashierId } },
      { $group: { _id: null, amount: { $sum: '$amount' } } },
    ]);
    return roundMoney(rows[0]?.amount ?? 0);
  }

  private async encashedTotal(cashierId: number): Promise<number> {
    const rows = await this.ledgerModel.aggregate<{ _id: null; amount: number }>([
      { $match: { cashierId, type: 'encashment' } },
      { $group: { _id: null, amount: { $sum: '$amount' } } },
    ]);
    return roundMoney(-(rows[0]?.amount ?? 0));
  }

  async getSummary(actor: CashOrdersActor, cashierIdParam?: number) {
    const target = await this.resolveTarget(actor, cashierIdParam);
    const [periods, encashed, till] = await Promise.all([
      this.earnedTotals(target.id),
      this.encashedTotal(target.id),
      this.tillBalance(target.id),
    ]);
    return {
      cashier: {
        id: target.id,
        email: target.email,
        pos_location: target.posLocation,
        is_active: target.isActive,
      },
      currency: CASH_CURRENCY,
      periods,
      encashed_total: encashed,
      till,
    };
  }


  /* ------------------------------------------------------------------ */
  /* Ряды для графиков                                                   */
  /* ------------------------------------------------------------------ */

  /**
   * Шаг сетки под окно: сутки показываем по часам, недели и месяц — по дням,
   * длинные окна — по месяцам. 180 дневных столбцов не читаются, поэтому
   * полгода и больше агрегируем помесячно.
   */
  private seriesGranularity(period: PeriodKey): SeriesGranularity {
    if (period === 'today') return 'hour';
    if (period === 'days7' || period === 'days30') return 'day';
    return 'month';
  }

  /** Ключ корзины в местном времени (ICT, без перехода на летнее). */
  private seriesKeyOf(ms: number, granularity: SeriesGranularity): string {
    const iso = new Date(ms + ICT_OFFSET_MS).toISOString();
    if (granularity === 'hour') return iso.slice(0, 13);
    if (granularity === 'day') return iso.slice(0, 10);
    return iso.slice(0, 7);
  }

  /** Начало следующей корзины — сеткой идём вперёд, а не прибавляем 30 дней. */
  private nextBucketMs(ms: number, granularity: SeriesGranularity): number {
    if (granularity === 'hour') return ms + HOUR_MS;
    if (granularity === 'day') return ms + DAY_MS;
    const local = new Date(ms + ICT_OFFSET_MS);
    const next = Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 1);
    return next - ICT_OFFSET_MS;
  }

  /** Начало корзины, в которую попадает момент. */
  private bucketStartMs(ms: number, granularity: SeriesGranularity): number {
    const local = new Date(ms + ICT_OFFSET_MS);
    if (granularity === 'hour') {
      return Date.UTC(
        local.getUTCFullYear(),
        local.getUTCMonth(),
        local.getUTCDate(),
        local.getUTCHours(),
      ) - ICT_OFFSET_MS;
    }
    if (granularity === 'day') {
      return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - ICT_OFFSET_MS;
    }
    return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - ICT_OFFSET_MS;
  }

  /**
   * Выручка и инкассации по времени для графиков кассира.
   *
   * Касса на конец корзины считается от остатка ДО окна, а не с нуля: иначе
   * линия кассы на коротком окне врала бы на весь накопленный остаток.
   */
  async getSeries(actor: CashOrdersActor, query: CashSeriesQueryDto) {
    const target = await this.resolveTarget(actor, query.cashierId);
    const period: PeriodKey = query.period ?? 'days30';
    const since = this.periodStart(period);
    const granularity = this.seriesGranularity(period);

    // Смещение в ICT прямо в конвейере: Таиланд без перехода на летнее время,
    // поэтому фиксированный сдвиг точен и не зависит от tz-базы Mongo.
    const format =
      granularity === 'hour' ? '%Y-%m-%dT%H' : granularity === 'day' ? '%Y-%m-%d' : '%Y-%m';
    const bucketKey = (field: unknown) => ({
      $dateToString: { format, date: { $add: [field, ICT_OFFSET_MS] } },
    });

    const orderMatch: Record<string, unknown> = { ...CASH_PAID_MATCH, cashierId: target.id };
    if (since != null) Object.assign(orderMatch, cashPaidAtAtLeast(since));
    /*
     * Начальный остаток (opening) — не движение во времени, а точка отсчёта:
     * миграция журнала проставила ему время своего запуска, то есть ПОЗЖЕ уже
     * случившихся инкассаций. Оставь мы его корзиной — накопительная линия
     * сначала уходила бы в минус на сумму инкассаций, а потом прыгала вверх.
     * Поэтому opening идёт в базу, а из корзин исключён.
     */
    const ledgerMatch: Record<string, unknown> = {
      cashierId: target.id,
      type: { $ne: 'opening' },
    };
    if (since != null) ledgerMatch.createdAt = { $gte: new Date(since) };

    /** Всё, что было до окна: начальный остаток плюс движения раньше границы. */
    const beforeWindowCondition =
      since == null
        ? false
        : {
            $and: [
              { $ne: ['$type', 'opening'] },
              { $lt: ['$createdAt', new Date(since)] },
            ],
          };

    const [salesRows, ledgerRows, openingRows] = await Promise.all([
      this.mockOrderModel.aggregate<{
        _id: string;
        revenue: number;
        orders: number;
        tickets: number;
      }>([
        { $match: orderMatch },
        {
          $group: {
            _id: bucketKey(CASH_PAID_AT),
            revenue: { $sum: '$total_price' },
            orders: { $sum: 1 },
            tickets: {
              $sum: {
                $reduce: {
                  input: { $ifNull: ['$tickets', []] },
                  initialValue: 0,
                  in: { $add: ['$$value', { $ifNull: ['$$this.count', 0] }] },
                },
              },
            },
          },
        },
      ]),
      this.ledgerModel.aggregate<{
        _id: string;
        encashed: number;
        encashments: number;
        net: number;
      }>([
        { $match: ledgerMatch },
        {
          $group: {
            _id: bucketKey('$createdAt'),
            // Инкассация лежит в журнале минусом — наружу отдаём модуль.
            encashed: {
              $sum: { $cond: [{ $eq: ['$type', 'encashment'] }, { $abs: '$amount' }, 0] },
            },
            encashments: {
              $sum: { $cond: [{ $eq: ['$type', 'encashment'] }, 1, 0] },
            },
            net: { $sum: '$amount' },
          },
        },
      ]),
      this.ledgerModel.aggregate<{ _id: null; opening: number; beforeWindow: number }>([
        { $match: { cashierId: target.id } },
        {
          $group: {
            _id: null,
            // Начальный остаток берём весь, независимо от его даты.
            opening: {
              $sum: { $cond: [{ $eq: ['$type', 'opening'] }, '$amount', 0] },
            },
            beforeWindow: { $sum: { $cond: [beforeWindowCondition, '$amount', 0] } },
          },
        },
      ]),
    ]);

    const salesByKey = new Map(salesRows.map((row) => [row._id, row]));
    const ledgerByKey = new Map(ledgerRows.map((row) => [row._id, row]));

    const now = Date.now();
    let cursor: number;
    if (since != null) {
      cursor = this.bucketStartMs(since, granularity);
    } else {
      // «Всё время» — от самой ранней записи; при пустой истории показываем
      // текущую корзину, чтобы график был пустым, а не сломанным.
      const keys = [...salesByKey.keys(), ...ledgerByKey.keys()].sort();
      const earliest = keys[0];
      cursor = earliest
        ? this.bucketStartMs(Date.parse(`${earliest}${SERIES_KEY_SUFFIX[granularity]}`) - ICT_OFFSET_MS, granularity)
        : this.bucketStartMs(now, granularity);
    }

    const lastBucket = this.bucketStartMs(now, granularity);
    let running = (openingRows[0]?.opening ?? 0) + (openingRows[0]?.beforeWindow ?? 0);
    const points: Array<{
      key: string;
      ts: string;
      revenue: number;
      orders: number;
      tickets: number;
      encashed: number;
      encashment_count: number;
      till_end: number;
    }> = [];

    // Верхняя граница на случай мусорной даты в базе: год часовых корзин.
    const MAX_POINTS = 9000;
    while (cursor <= lastBucket && points.length < MAX_POINTS) {
      const key = this.seriesKeyOf(cursor, granularity);
      const sale = salesByKey.get(key);
      const ledger = ledgerByKey.get(key);
      running += ledger?.net ?? 0;
      points.push({
        key,
        ts: new Date(cursor).toISOString(),
        revenue: roundMoney(sale?.revenue ?? 0),
        orders: sale?.orders ?? 0,
        tickets: sale?.tickets ?? 0,
        encashed: roundMoney(ledger?.encashed ?? 0),
        encashment_count: ledger?.encashments ?? 0,
        till_end: roundMoney(running),
      });
      cursor = this.nextBucketMs(cursor, granularity);
    }

    const totals = points.reduce(
      (acc, point) => ({
        revenue: acc.revenue + point.revenue,
        orders: acc.orders + point.orders,
        tickets: acc.tickets + point.tickets,
        encashed: acc.encashed + point.encashed,
        encashment_count: acc.encashment_count + point.encashment_count,
      }),
      { revenue: 0, orders: 0, tickets: 0, encashed: 0, encashment_count: 0 },
    );

    return {
      cashier: { id: target.id, email: target.email },
      currency: CASH_CURRENCY,
      period,
      granularity,
      points,
      totals: {
        ...totals,
        revenue: roundMoney(totals.revenue),
        encashed: roundMoney(totals.encashed),
      },
    };
  }


  /* ------------------------------------------------------------------ */
  /* Порог кассы: письмо админам на каждые 50 000                        */
  /* ------------------------------------------------------------------ */

  /**
   * Сверяет кассу владельца с порогом и, если взят новый уровень, шлёт письмо
   * админам. Вызывается после КАЖДОГО движения, включая уменьшающие: касса
   * упала — ватерлиния опускается, и следующий переход снова сработает.
   *
   * Никогда не бросает: подтверждение оплаты не должно падать из-за письма.
   */
  private async syncTillAlert(cashierId: number, cashierEmail: string): Promise<void> {
    try {
      const till = await this.tillBalance(cashierId);
      const step = till > 0 ? Math.floor(till / CASH_TILL_ALERT_STEP) : 0;
      const current = await this.tillAlertModel.findOne({ cashierId }).lean().exec();
      const notified = current?.lastNotifiedStep ?? 0;

      if (step <= notified) {
        if (step < notified) {
          await this.tillAlertModel
            .updateOne(
              { cashierId },
              { $set: { lastNotifiedStep: step, lastNotifiedTill: till } },
              { upsert: true },
            )
            .exec();
        }
        return;
      }

      /*
       * Уровень занимаем атомарно: два одновременных подтверждения пересчитают
       * одну и ту же кассу, но письмо уйдёт только у того, чей update совпал
       * с прежним значением ватерлинии.
       */
      let claimed = false;
      if (current) {
        const res = await this.tillAlertModel
          .updateOne(
            { cashierId, lastNotifiedStep: notified },
            {
              $set: {
                lastNotifiedStep: step,
                lastNotifiedTill: till,
                lastNotifiedAt: new Date(),
                cashierEmail,
              },
            },
          )
          .exec();
        claimed = res.modifiedCount > 0;
      } else {
        try {
          await this.tillAlertModel.create({
            cashierId,
            cashierEmail,
            lastNotifiedStep: step,
            lastNotifiedTill: till,
            lastNotifiedAt: new Date(),
          });
          claimed = true;
        } catch (error) {
          // Гонка на первой записи: уровень занял другой вызов.
          if ((error as { code?: number })?.code !== 11000) throw error;
        }
      }

      if (!claimed) return;
      await this.sendTillThresholdEmail(cashierId, cashierEmail, till, step);
    } catch (error) {
      this.logger.error(
        `Till threshold check failed for cashierId=${cashierId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Получатели письма о пороге. Настройки читаем в момент отправки, без кэша:
   * адрес, сохранённый в админке минуту назад, должен сработать сразу.
   * Сбой чтения настроек письмо не отправляет (запасных получателей нет) — только лог.
   */
  private async tillAlertRecipients(): Promise<string[]> {
    try {
      const settings = await this.cashSettingsModel
        .findOne({ key: CASH_SETTINGS_KEY })
        .select('tillAlertEmails')
        .lean()
        .exec();
      return resolveTillAlertRecipients(settings?.tillAlertEmails);
    } catch (error) {
      this.logger.error(
        `Failed to read cash settings, till alert not sent: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return [];
    }
  }

  /** Письмо ответственным: у кого и на сколько выросла касса. */
  private async sendTillThresholdEmail(
    cashierId: number,
    cashierEmail: string,
    till: number,
    step: number,
  ): Promise<void> {
    const recipients = await this.tillAlertRecipients();
    if (recipients.length === 0) {
      this.logger.warn(
        `Till threshold reached for cashierId=${cashierId}, but no till alert recipients are set — nothing sent`,
      );
      return;
    }

    const threshold = step * CASH_TILL_ALERT_STEP;
    const money = (value: number) =>
      `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(value)} ${CASH_CURRENCY}`;

    const who =
      cashierId === 0
        ? 'касса админки (заказы, подтверждённые из панели)'
        : `кассир ${cashierEmail || `#${cashierId}`}`;
    const posLine =
      cashierId === 0
        ? ''
        : await this.cashierModel
            .findOne({ id: cashierId })
            .select('posLocation')
            .lean()
            .exec()
            .then((row) => row?.posLocation ?? '');

    const subject = `Касса превысила ${money(threshold)}: ${
      cashierId === 0 ? 'админка' : cashierEmail || `кассир #${cashierId}`
    }`;
    const rows: Array<[string, string]> = [
      ['Владелец кассы', who],
      ...(posLine ? ([['Точка продаж', posLine]] as Array<[string, string]>) : []),
      ['Касса сейчас', money(till)],
      ['Пройденный порог', money(threshold)],
      ['Шаг уведомления', money(CASH_TILL_ALERT_STEP)],
    ];
    const text = rows.map(([label, value]) => `${label}: ${value}`).join('\n');
    const html = [
      '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111">',
      `<p style="margin:0 0 12px"><strong>${subject}</strong></p>`,
      '<table cellpadding="6" cellspacing="0" style="border-collapse:collapse">',
      ...rows.map(
        ([label, value]) =>
          `<tr><td style="color:#666">${label}</td><td style="font-weight:600">${value}</td></tr>`,
      ),
      '</table>',
      '<p style="margin:12px 0 0;color:#666">Следующее письмо — при переходе через ' +
        `${money(threshold + CASH_TILL_ALERT_STEP)}.</p>`,
      '</div>',
    ].join('');

    await Promise.all(
      recipients.map((to) => this.notificationService.sendEmail({ to, subject, text, html })),
    );
    this.logger.log(
      `Till threshold ${threshold} ${CASH_CURRENCY} reported for cashierId=${cashierId} ` +
        `to ${recipients.length} recipient(s)`,
    );
  }

  /* ------------------------------------------------------------------ */
  /* Журнал: чтение и записи                                             */
  /* ------------------------------------------------------------------ */

  /**
   * История движений владельца. Продажи в таблицу не выводим — их слишком
   * много и они видны как заказы; всё остальное (инкассации, возвраты,
   * корректировки, начальный остаток) обязано быть на виду.
   */
  async listEncashments(actor: CashOrdersActor, query: EncashmentsQueryDto) {
    const target = await this.resolveTarget(actor, query.cashierId);
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const filter: Record<string, unknown> = {
      cashierId: target.id,
      type: { $ne: 'sale' },
    };
    if (query.from || query.to) {
      const createdAt: Record<string, Date> = {};
      if (query.from) createdAt.$gte = new Date(ictDayStringStartMs(query.from));
      if (query.to) createdAt.$lt = new Date(ictDayStringStartMs(query.to) + DAY_MS);
      // Regexp в DTO пропускает "2026-99-99" — не даём NaN дойти до Mongo как 500.
      if (Object.values(createdAt).some((date) => Number.isNaN(date.getTime()))) {
        throw new BadRequestException('invalid_date_range');
      }
      filter.createdAt = createdAt;
    }

    const [total, rows] = await Promise.all([
      this.ledgerModel.countDocuments(filter).exec(),
      this.ledgerModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean()
        .exec(),
    ]);

    return {
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
      rows: rows.map((row) => this.toMovementRow(row)),
    };
  }

  private toMovementRow(row: ICashLedgerEntry | Record<string, unknown>) {
    const entry = row as ICashLedgerEntry;
    return {
      id: entry.id,
      type: entry.type,
      amount: entry.amount,
      currency: entry.currency ?? CASH_CURRENCY,
      collector_name: entry.collectorName ?? null,
      note: entry.note ?? null,
      order_id: entry.orderId ?? null,
      cashier_email: entry.cashierEmail,
      /** Журнал действий: кто именно сделал движение. */
      created_by: entry.createdBy ?? null,
      created_by_role: entry.createdByRole ?? null,
      created_at:
        entry.createdAt instanceof Date ? entry.createdAt.toISOString() : String(entry.createdAt),
    };
  }

  async createEncashment(actor: CashOrdersActor, dto: CreateEncashmentDto) {
    /*
     * Деньги сдаёт тот, у кого они на руках: кассир — свою кассу, админ —
     * общую кассу админки. Сдать ЧУЖУЮ кассу нельзя — cashierId не принимается.
     */
    const target = await this.resolveTarget(actor);
    const author = await this.resolveActor(actor);
    const till = await this.tillBalance(target.id);
    // Обе стороны до сатанга: tillBalance уже округлён, сумма из DTO — не больше 2 знаков.
    if (roundMoney(dto.amount) > till) {
      throw new BadRequestException('encashment_exceeds_till');
    }

    const created = await new this.ledgerModel({
      cashierId: target.id,
      cashierEmail: target.email,
      type: 'encashment',
      amount: -dto.amount,
      currency: CASH_CURRENCY,
      collectorName: dto.collector_name.trim(),
      createdBy: author.email,
      createdById: author.id,
      createdByRole: author.role,
    }).save();

    /*
     * Компенсирующая проверка вместо транзакции: два одновременных сабмита
     * оба проходят проверку выше, но после вставки баланс пересчитывается,
     * и ушедший в минус откатывает свою строку. Перерасход невозможен.
     */
    const after = await this.tillBalance(target.id);
    if (after < 0) {
      await this.ledgerModel.deleteOne({ _id: created._id }).exec();
      throw new BadRequestException('encashment_exceeds_till');
    }

    void this.syncTillAlert(target.id, target.email);
    return {
      row: this.toMovementRow(created),
      till: after,
    };
  }

  /** Ручная корректировка кассы админом — единственный способ «исправить» журнал. */
  async createAdjustment(actor: CashOrdersActor, dto: CreateAdjustmentDto) {
    if (actor.type !== 'Admin') {
      throw new BadRequestException('admin_only');
    }
    const target = await this.resolveTarget(actor, dto.cashier_id);
    const author = await this.resolveActor(actor);
    const created = await new this.ledgerModel({
      cashierId: target.id,
      cashierEmail: target.email,
      type: 'adjustment',
      amount: dto.amount,
      currency: CASH_CURRENCY,
      note: dto.note.trim(),
      createdBy: author.email,
      createdById: author.id,
      createdByRole: author.role,
    }).save();
    this.logger.log(
      `Cash adjustment by ${author.email}: cashierId=${target.id} amount=${dto.amount} note="${dto.note.trim()}"`,
    );
    void this.syncTillAlert(target.id, target.email);
    return {
      row: this.toMovementRow(created),
      till: await this.tillBalance(target.id),
    };
  }

  /**
   * Обнуление кассы админом: одна строка журнала ровно на текущий остаток,
   * с автором и причиной. Деньги не «стираются» — движение видно в истории
   * и в Excel, а баланс после него равен нулю.
   */
  async resetTill(actor: CashOrdersActor, dto: ResetTillDto) {
    if (actor.type !== 'Admin') {
      throw new BadRequestException('admin_only');
    }
    const target = await this.resolveTarget(actor, dto.cashier_id);
    const author = await this.resolveActor(actor);
    const till = await this.tillBalance(target.id);
    if (till === 0) {
      throw new BadRequestException('till_already_zero');
    }

    const created = await new this.ledgerModel({
      cashierId: target.id,
      cashierEmail: target.email,
      type: 'reset',
      amount: -till,
      currency: CASH_CURRENCY,
      note: dto.note.trim(),
      createdBy: author.email,
      createdById: author.id,
      createdByRole: author.role,
    }).save();

    this.logger.warn(
      `Cash till reset by ${author.email}: cashierId=${target.id} (${target.email}) ` +
        `from ${till} to 0, note="${dto.note.trim()}"`,
    );

    void this.syncTillAlert(target.id, target.email);
    return {
      row: this.toMovementRow(created),
      till: await this.tillBalance(target.id),
      previous_till: till,
    };
  }

  /**
   * Продажа в журнал — вызывается при подтверждении оплаты наличными.
   * Частичный уникальный индекс по (orderId, sale) гарантирует одну строку
   * на заказ; повторная финализация просто ничего не добавит.
   */
  async recordSale(order: IMockOrder, cashierId: number, cashierEmail: string): Promise<void> {
    try {
      await new this.ledgerModel({
        cashierId,
        cashierEmail,
        type: 'sale',
        amount: order.total_price,
        currency: CASH_CURRENCY,
        orderId: order.id,
        createdBy: cashierEmail,
      }).save();
      void this.syncTillAlert(cashierId, cashierEmail);
    } catch (error) {
      if ((error as { code?: number })?.code === 11000) return;
      // Билеты уже выданы — журнал не должен валить подтверждение, но молчать нельзя.
      this.logger.error(
        `Cash ledger sale row failed for order ${order.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Возврат по заказу наличными: явная минус-строка владельцу продажи.
   * Касса может уйти в минус — это видимый факт «деньги уже сданы, а возврат
   * выплачен», который админ закрывает корректировкой.
   */
  async recordRefund(order: IMockOrder, refundAmount: number): Promise<void> {
    try {
      let cashierId = (order as { cashierId?: number }).cashierId;
      if (cashierId == null) {
        if (order.cashierEmail === 'admin') {
          cashierId = 0;
        } else {
          const cashier = await this.cashierModel
            .findOne({ email: order.cashierEmail ?? '' })
            .select('id')
            .lean()
            .exec();
          cashierId = cashier?.id ?? 0;
        }
      }
      await new this.ledgerModel({
        cashierId,
        cashierEmail: order.cashierEmail ?? 'admin',
        type: 'refund',
        amount: -Math.abs(refundAmount),
        currency: CASH_CURRENCY,
        orderId: order.id,
        createdBy: 'admin',
      }).save();
      void this.syncTillAlert(cashierId, order.cashierEmail ?? 'admin');
    } catch (error) {
      this.logger.error(
        `Cash ledger refund row failed for order ${order.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Строка продажи заказа и текущая касса её владельца — для превью удаления
   * билетов в служебных инструментах админки. null — строки нет (заказ вошёл
   * в начальный остаток), кассу по такому заказу скорректировать нельзя.
   */
  async getSaleRowForOrder(orderId: number): Promise<{
    raw: Record<string, unknown>;
    cashierId: number;
    cashierEmail: string;
    amount: number;
    till: number;
  } | null> {
    const row = await this.ledgerModel.findOne({ orderId, type: 'sale' }).lean().exec();
    if (!row) return null;
    return {
      raw: row as unknown as Record<string, unknown>,
      cashierId: row.cashierId,
      cashierEmail: row.cashierEmail,
      amount: row.amount,
      till: await this.tillBalance(row.cashierId),
    };
  }

  /**
   * ВНИМАНИЕ: сознательное нарушение правила «строки журнала не редактируются
   * и не удаляются» — только для удаления билетов «без следа» из служебных
   * инструментов админки. Продажа должна выглядеть так, будто удалённых билетов
   * не продавали, поэтому строка продажи переписывается на новую сумму заказа
   * (`amount === null` — удаляется вместе с заказом), а не гасится корректировкой.
   * Исходная строка сохраняется в архиве ticketremovals.
   *
   * false — строки продажи нет (или она исчезла между чтением и записью).
   */
  async rewriteSaleRowForTicketRemoval(orderId: number, amount: number | null): Promise<boolean> {
    const row = await this.ledgerModel
      .findOne({ orderId, type: 'sale' })
      .select({ _id: 1, cashierId: 1, cashierEmail: 1 })
      .lean()
      .exec();
    if (!row) return false;
    if (amount === null) {
      const res = await this.ledgerModel.deleteOne({ _id: row._id }).exec();
      if (!res.deletedCount) return false;
    } else {
      // updatedAt не трогаем: строка должна выглядеть исходной.
      const res = await this.ledgerModel
        .updateOne({ _id: row._id }, { $set: { amount: roundMoney(amount) } }, { timestamps: false })
        .exec();
      if (!res.matchedCount) return false;
    }
    void this.syncTillAlert(row.cashierId, row.cashierEmail);
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* Журнал проверок броней (сканы и ручной ввод)                        */
  /* ------------------------------------------------------------------ */

  /**
   * Пишется на каждый lookup, включая ненайденные коды: журнал должен
   * показывать, что кассир держал в руках, даже если оплата не прошла.
   * Никогда не роняет сам lookup — проверка брони важнее её протокола.
   */
  async recordScan(params: {
    actor: CashOrdersActor;
    code: string;
    source: CashScanSource;
    order?: {
      id: number;
      bookingCode?: string | null;
      eventId?: number;
      eventTitle?: ILocalizedText;
      ticketsCount: number;
      amount: number;
      currency?: string;
      status: string;
    } | null;
  }): Promise<void> {
    try {
      const author = await this.resolveActor(params.actor);
      const cashierId = author.role === 'CashierArbi' ? author.id : 0;
      await new this.scanEventModel({
        cashierId,
        cashierEmail: author.email,
        code: params.code,
        source: params.source,
        found: params.order != null,
        orderId: params.order?.id,
        bookingCode: params.order?.bookingCode ?? undefined,
        eventId: params.order?.eventId,
        eventTitle: params.order?.eventTitle,
        ticketsCount: params.order?.ticketsCount,
        amount: params.order?.amount,
        currency: params.order?.currency ?? CASH_CURRENCY,
        orderStatus: params.order?.status,
      }).save();
    } catch (error) {
      this.logger.warn(
        `Cash scan log failed for code ${params.code}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * История проверок за период. Итог каждой строки (оплачена ли бронь сейчас
   * и кто её подтвердил) берётся из заказа на момент чтения, а не из снимка:
   * кассиру нужен ответ «чем это закончилось», а не «что было тогда».
   */
  async listScans(actor: CashOrdersActor, query: ScansQueryDto) {
    const target = await this.resolveTarget(actor, query.cashierId);
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const filter: Record<string, unknown> = { cashierId: target.id };
    const since = this.periodStart(query.period ?? 'today');
    if (since != null) filter.createdAt = { $gte: new Date(since) };

    const [total, rows, totals] = await Promise.all([
      this.scanEventModel.countDocuments(filter).exec(),
      this.scanEventModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean()
        .exec(),
      this.scanEventModel.aggregate<{ _id: null; scans: number; tickets: number; amount: number }>([
        { $match: { ...filter, found: true } },
        {
          $group: {
            _id: null,
            scans: { $sum: 1 },
            tickets: { $sum: { $ifNull: ['$ticketsCount', 0] } },
            amount: { $sum: { $ifNull: ['$amount', 0] } },
          },
        },
      ]),
    ]);

    const orderIds = rows
      .map((row) => row.orderId)
      .filter((id): id is number => typeof id === 'number');
    const orders = orderIds.length
      ? await this.mockOrderModel
          .find({ id: { $in: orderIds } })
          .select('id status cashierEmail paymentConfirmedAt')
          .lean()
          .exec()
      : [];
    const orderById = new Map(orders.map((order) => [order.id, order]));

    return {
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
      currency: CASH_CURRENCY,
      totals: {
        scans: totals[0]?.scans ?? 0,
        tickets: totals[0]?.tickets ?? 0,
        amount: roundMoney(totals[0]?.amount ?? 0),
      },
      rows: rows.map((row) => {
        const order = row.orderId != null ? orderById.get(row.orderId) : undefined;
        return {
          id: row.id,
          code: row.code,
          source: row.source,
          found: row.found,
          order_id: row.orderId ?? null,
          booking_code: row.bookingCode ?? null,
          event_title: row.eventTitle ?? null,
          tickets_count: row.ticketsCount ?? 0,
          amount: row.amount ?? 0,
          currency: row.currency ?? CASH_CURRENCY,
          /** Статус в момент проверки и сейчас — видно, что изменилось после скана. */
          status_at_scan: row.orderStatus ?? null,
          current_status: order?.status ?? null,
          confirmed_by: order?.cashierEmail ?? null,
          scanned_at:
            row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
        };
      }),
    };
  }

  /* ------------------------------------------------------------------ */
  /* Справочник инкассаторов                                             */
  /* ------------------------------------------------------------------ */

  async listCollectors() {
    const collectors = await this.collectorModel
      .find()
      .sort({ name: 1 })
      .lean()
      .exec();
    return collectors.map((collector) => ({
      id: collector.id,
      name: collector.name,
    }));
  }

  async createCollector(dto: CreateCollectorDto) {
    const name = dto.name.trim();
    // Уникальный индекс строится асинхронно и не различает регистр — проверяем сами.
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const duplicate = await this.collectorModel
      .exists({ name: new RegExp(`^${escaped}$`, 'i') })
      .exec();
    if (duplicate) {
      throw new ConflictException('cash_collector_already_exists');
    }
    try {
      const created = await new this.collectorModel({ name }).save();
      return { id: created.id, name: created.name };
    } catch (error) {
      if ((error as { code?: number })?.code === 11000) {
        throw new ConflictException('cash_collector_already_exists');
      }
      throw error;
    }
  }

  async removeCollector(id: number): Promise<{ ok: true }> {
    const deleted = await this.collectorModel.findOneAndDelete({ id }).lean().exec();
    if (!deleted) {
      throw new NotFoundException('cash_collector_not_found');
    }
    return { ok: true };
  }

  /* ------------------------------------------------------------------ */
  /* Настройки кассы: получатели письма о пороге                         */
  /* ------------------------------------------------------------------ */

  private cashSettingsResponse(tillAlertEmails: string[]) {
    return { tillAlertEmails, step: CASH_TILL_ALERT_STEP };
  }

  /** Документа может ещё не быть — тогда список пуст, ничего не создаём. */
  async getCashSettings() {
    const settings = await this.cashSettingsModel
      .findOne({ key: CASH_SETTINGS_KEY })
      .select('tillAlertEmails')
      .lean()
      .exec();
    return this.cashSettingsResponse(settings?.tillAlertEmails ?? []);
  }

  /** Адреса уже нормализованы DTO (trim, нижний регистр, без повторов). */
  async updateCashSettings(dto: UpdateCashSettingsDto, adminId?: string) {
    const numericAdminId = Number(adminId);
    const settings = await this.cashSettingsModel
      .findOneAndUpdate(
        { key: CASH_SETTINGS_KEY },
        {
          $set: {
            tillAlertEmails: dto.tillAlertEmails,
            updatedByAdminId: Number.isInteger(numericAdminId) ? numericAdminId : null,
          },
        },
        { new: true, upsert: true, setDefaultsOnInsert: true },
      )
      .select('tillAlertEmails')
      .lean()
      .exec();
    this.logger.log(
      `Till alert recipients updated by adminId=${adminId ?? '?'}: ${dto.tillAlertEmails.length} address(es)`,
    );
    return this.cashSettingsResponse(settings?.tillAlertEmails ?? dto.tillAlertEmails);
  }

  /* ------------------------------------------------------------------ */
  /* Обзор для страницы «Кассиры»                                        */
  /* ------------------------------------------------------------------ */

  /** Кассы всех владельцев разом — для шапки и таблицы страницы «Кассиры». */
  async getOverview() {
    const [cashiers, earnedRows, tillRows] = await Promise.all([
      this.cashierModel.find().sort({ id: 1 }).lean().exec(),
      this.mockOrderModel.aggregate<{ _id: number; amount: number; orders: number }>([
        { $match: { ...CASH_PAID_MATCH, cashierId: { $type: 'number' } } },
        {
          $group: {
            _id: '$cashierId',
            amount: { $sum: '$total_price' },
            orders: { $sum: 1 },
          },
        },
      ]),
      this.ledgerModel.aggregate<{ _id: number; till: number; encashed: number }>([
        {
          $group: {
            _id: '$cashierId',
            till: { $sum: '$amount' },
            encashed: {
              $sum: { $cond: [{ $eq: ['$type', 'encashment'] }, '$amount', 0] },
            },
          },
        },
      ]),
    ]);

    const earnedById = new Map(earnedRows.map((row) => [row._id, row]));
    const ledgerById = new Map(tillRows.map((row) => [row._id, row]));

    const rows = cashiers.map((cashier) => {
      const earned = earnedById.get(cashier.id);
      const ledger = ledgerById.get(cashier.id);
      return {
        id: cashier.id,
        email: cashier.email,
        pos_location: cashier.posLocation,
        is_active: cashier.isActive !== false,
        earned_all: roundMoney(earned?.amount ?? 0),
        orders_all: earned?.orders ?? 0,
        encashed_all: roundMoney(-(ledger?.encashed ?? 0)),
        till: roundMoney(ledger?.till ?? 0),
      };
    });

    const adminLedger = ledgerById.get(0);
    const adminTill = roundMoney(adminLedger?.till ?? 0);

    return {
      currency: CASH_CURRENCY,
      // Физическая наличность на руках у всех: кассиры + касса админки.
      total_till: roundMoney(rows.reduce((sum, row) => sum + row.till, 0) + adminTill),
      admin_till: adminTill,
      rows,
    };
  }
}
