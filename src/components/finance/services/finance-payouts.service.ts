import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { MediaService } from '../../media/media.service';
import { IOrganizerPayoutReceipt, organizerPayoutModel } from '../schemas/organizer-payout.schema';
import {
  FINANCE_CURRENCIES,
  FinanceCurrency,
  FinanceEventRecord,
  FinancePayout,
  FinancePayoutActor,
  FinanceReceiptFile,
  FinanceUploadedFile,
  PAYOUT_SOURCES,
  PAYOUT_STATUSES,
  PAYOUT_TYPES,
  PayoutSource,
  PayoutStatus,
  PayoutType,
} from '../types/finance.types';
import {
  FINANCE_RECEIPT_MAX_BYTES,
  FINANCE_RECEIPT_MAX_FILES,
  isAllowedReceiptMime,
  normalizeMime,
  sanitizeReceiptName,
} from '../utils/finance-files.util';
import { MONEY_EPS, ictDayStartMs, round2, roundRate } from '../utils/finance-money.util';
import { LeanOrganizerPayout, toFinancePayout } from '../utils/finance-payout-mapper.util';
import { FinanceBalancesService } from './finance-balances.service';
import { FinanceDirectoryService } from './finance-directory.service';

export const FINANCE_ERRORS = {
  vaultThbOnly: 'finance_vault_thb_only',
  rateRequired: 'finance_rate_required',
  receiptRequired: 'finance_receipt_required',
  receiptInvalidType: 'finance_receipt_invalid_type',
  receiptEmpty: 'finance_receipt_empty',
  receiptTooLarge: 'finance_receipt_too_large',
  receiptTooMany: 'finance_receipt_too_many',
  receiptNotFound: 'finance_receipt_not_found',
  amountInvalid: 'finance_amount_invalid',
  amountExceedsAvailable: 'finance_amount_exceeds_available',
  payoutNotFound: 'finance_payout_not_found',
  payoutNotPending: 'finance_payout_not_pending',
  invalidPayload: 'finance_invalid_payload',
  noteTooLong: 'finance_note_too_long',
} as const;

export const FINANCE_NOTE_MAX = 1000;
export const FINANCE_REJECT_REASON_MAX = 500;
const LIST_LIMIT = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

export type CreateAdminPayoutInput = {
  type: PayoutType;
  amount: number;
  currency: FinanceCurrency;
  rateToThb?: number | null;
  source: PayoutSource;
  note?: string | null;
};

const bad = (code: string) => new BadRequestException(code);

/**
 * Выплаты организаторам (spec §1.4) — единственное место, которое их пишет.
 * Квитанции кладутся через существующий MediaService приватными медиа.
 */
@Injectable()
export class FinancePayoutsService {
  private readonly logger = new Logger(FinancePayoutsService.name);

  constructor(
    private readonly mediaService: MediaService,
    private readonly directory: FinanceDirectoryService,
    private readonly balances: FinanceBalancesService,
  ) {}

  private get payoutModel() {
    return organizerPayoutModel();
  }

  /* ------------------------------------------------------------------ */
  /* Чтение                                                              */
  /* ------------------------------------------------------------------ */

  /** Выплаты события, новые первыми; `from/to` — ICT-дни createdAt включительно. */
  async listEventPayouts(
    eventId: number,
    period?: { from?: string | null; to?: string | null },
    eventTitle?: string,
  ): Promise<FinancePayout[]> {
    const createdAt: Record<string, Date> = {};
    if (period?.from) createdAt.$gte = new Date(ictDayStartMs(period.from));
    if (period?.to) createdAt.$lt = new Date(ictDayStartMs(period.to) + DAY_MS);
    const rows = await this.payoutModel
      .find({ eventId, ...(Object.keys(createdAt).length ? { createdAt } : {}) })
      .sort({ createdAt: -1, id: -1 })
      .lean<LeanOrganizerPayout[]>()
      .exec();
    const title = eventTitle ?? (await this.directory.eventTitles([eventId])).get(eventId) ?? `#${eventId}`;
    return rows.map((row) => toFinancePayout(row, title));
  }

  /** Все выплаты (или с данным статусом), новые первыми, с названиями событий. */
  async listPayouts(status?: PayoutStatus | null): Promise<FinancePayout[]> {
    if (status && !(PAYOUT_STATUSES as readonly string[]).includes(status)) throw bad(FINANCE_ERRORS.invalidPayload);
    const rows = await this.payoutModel
      .find(status ? { status } : {})
      .sort({ createdAt: -1, id: -1 })
      .limit(LIST_LIMIT)
      .lean<LeanOrganizerPayout[]>()
      .exec();
    const titles = await this.directory.eventTitles(rows.map((row) => row.eventId));
    return rows.map((row) => toFinancePayout(row, titles.get(row.eventId) ?? `#${row.eventId}`));
  }

  async getPayout(payoutId: number): Promise<FinancePayout> {
    const row = await this.findPayout(payoutId);
    return this.mapOne(row);
  }

  /**
   * Файл квитанции для гвардированной отдачи. Квитанция обязана принадлежать
   * этой выплате (и событию, если передано) — иначе 404, чужие медиа не отдаются.
   */
  async getReceiptFile(payoutId: number, receiptId: number, eventId?: number): Promise<FinanceReceiptFile> {
    const payout = await this.payoutModel
      .findOne({ id: payoutId })
      .select('id eventId receipts')
      .lean<Pick<LeanOrganizerPayout, 'id' | 'eventId' | 'receipts'>>()
      .exec();
    if (!payout || (eventId !== undefined && payout.eventId !== eventId)) {
      throw new NotFoundException(FINANCE_ERRORS.payoutNotFound);
    }
    const receipt = (payout.receipts ?? []).find((item) => item.id === receiptId);
    if (!receipt) throw new NotFoundException(FINANCE_ERRORS.receiptNotFound);
    let media: Awaited<ReturnType<MediaService['getById']>>;
    try {
      media = await this.mediaService.getById(receiptId);
    } catch {
      throw new NotFoundException(FINANCE_ERRORS.receiptNotFound);
    }
    const file = media.file as unknown;
    const buffer = Buffer.isBuffer(file)
      ? file
      : Buffer.from((file as { buffer?: ArrayBuffer })?.buffer ?? (file as ArrayBuffer));
    return {
      buffer,
      mimeType: normalizeMime(media.mimeType) || receipt.mimeType,
      name: receipt.name,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Запись                                                              */
  /* ------------------------------------------------------------------ */

  /**
   * Выплата, проведённая админом: сразу completed, минимум одна квитанция.
   * Сумма НЕ ограничена доступным балансом (аванс до продаж законен).
   */
  async createAdminPayout(
    eventId: number,
    input: CreateAdminPayoutInput,
    files: FinanceUploadedFile[] | undefined,
    adminId: string | number,
  ): Promise<FinancePayout> {
    const event = await this.directory.getAdminEvent(eventId);
    if (!(PAYOUT_TYPES as readonly string[]).includes(input.type)) throw bad(FINANCE_ERRORS.invalidPayload);
    if (!(FINANCE_CURRENCIES as readonly string[]).includes(input.currency)) throw bad(FINANCE_ERRORS.invalidPayload);
    if (!(PAYOUT_SOURCES as readonly string[]).includes(input.source)) throw bad(FINANCE_ERRORS.invalidPayload);
    const amount = this.assertAmount(input.amount);
    const note = this.normalizeNote(input.note);
    if (input.source === 'vault' && input.currency !== 'THB') throw bad(FINANCE_ERRORS.vaultThbOnly);
    const uploads = this.assertFiles(files);
    if (!uploads.length) throw bad(FINANCE_ERRORS.receiptRequired);
    const rateToThb = await this.resolveRate(event, input.currency, input.rateToThb);

    const label = await this.directory.resolveAdminLabel(adminId);
    const receipts = await this.storeReceipts(uploads, event.creator, label);
    const now = new Date();
    try {
      const saved = await new this.payoutModel({
        eventId: event.id,
        organizerId: event.creator,
        type: input.type,
        amount,
        currency: input.currency,
        rateToThb,
        amountThb: round2(amount * rateToThb),
        source: input.source,
        status: 'completed',
        note,
        requestedByOrganizer: false,
        receipts,
        createdByKind: 'admin',
        createdById: this.numericId(adminId),
        createdByLabel: label,
        resolvedAt: now,
        resolvedByLabel: label,
        rejectReason: null,
      }).save();
      this.logger.log(
        `Payout PO-${saved.id} by ${label}: event=${event.id} ${amount} ${input.currency} (${saved.amountThb} THB) via ${input.source}`,
      );
      return toFinancePayout(saved.toObject() as LeanOrganizerPayout, event.title);
    } catch (error) {
      await this.removeMedia(receipts);
      throw error;
    }
  }

  /**
   * Запрос выплаты организатором: pending, interim, THB, курс 1, источник не
   * выбран. Сумма ≤ доступного баланса события (с допуском полсатанга).
   * Владение событием проверяет вызывающий контроллер.
   */
  async createOrganizerRequest(params: {
    eventId: number;
    amount: number;
    note?: string | null;
    actor: FinancePayoutActor;
  }): Promise<FinancePayout> {
    const amount = this.assertAmount(params.amount);
    const note = this.normalizeNote(params.note);
    const event = await this.directory.findEventRecord(params.eventId);
    const snapshot = await this.balances.loadSnapshot([event.id], { cash: 'event' });
    const sales = FinanceBalancesService.salesOf(snapshot, event);
    const before = FinanceBalancesService.balancesOf(snapshot, event, sales);
    if (amount > Math.max(before.availableThb, 0) + MONEY_EPS) {
      throw bad(FINANCE_ERRORS.amountExceedsAvailable);
    }

    const saved = await new this.payoutModel({
      eventId: event.id,
      organizerId: event.creator,
      type: 'interim',
      amount,
      currency: 'THB',
      rateToThb: 1,
      amountThb: round2(amount),
      source: null,
      status: 'pending',
      note,
      requestedByOrganizer: true,
      receipts: [],
      createdByKind: params.actor.kind,
      createdById: params.actor.id,
      createdByLabel: params.actor.label,
      resolvedAt: null,
      resolvedByLabel: null,
      rejectReason: null,
    }).save();

    /*
     * Компенсирующая проверка вместо транзакции (как у инкассаций): два
     * одновременных запроса оба проходят проверку выше, но после вставки баланс
     * пересчитывается, и ушедший в минус запрос откатывает СВОЮ только что
     * созданную строку. Это единственное удаление выплаты — строки, которой
     * никто ещё не видел. Вставка pending-выплаты не меняет ни продаж, ни наличных,
     * поэтому перечитываются только итоги выплат.
     */
    const after = FinanceBalancesService.balancesOf(
      { ...snapshot, payoutGroups: await this.balances.loadPayoutGroups() },
      event,
      sales,
    );
    if (after.availableThb < -2 * MONEY_EPS) {
      await this.payoutModel.deleteOne({ _id: saved._id }).exec();
      throw bad(FINANCE_ERRORS.amountExceedsAvailable);
    }
    this.logger.log(`Payout request PO-${saved.id} by ${params.actor.label}: event=${event.id} ${amount} THB`);
    return toFinancePayout(saved.toObject() as LeanOrganizerPayout, event.title);
  }

  /** Провести запрос: только pending; источник обязателен; после — ≥ 1 квитанция. */
  async completePayout(
    payoutId: number,
    input: { source: PayoutSource; note?: string | null },
    files: FinanceUploadedFile[] | undefined,
    adminId: string | number,
  ): Promise<FinancePayout> {
    const payout = await this.findPayout(payoutId);
    if (payout.status !== 'pending') throw bad(FINANCE_ERRORS.payoutNotPending);
    if (!(PAYOUT_SOURCES as readonly string[]).includes(input.source)) throw bad(FINANCE_ERRORS.invalidPayload);
    if (input.source === 'vault' && payout.currency !== 'THB') throw bad(FINANCE_ERRORS.vaultThbOnly);
    const note = input.note == null ? '' : this.normalizeNote(input.note);
    const uploads = this.assertFiles(files);
    if ((payout.receipts?.length ?? 0) + uploads.length < 1) throw bad(FINANCE_ERRORS.receiptRequired);

    const label = await this.directory.resolveAdminLabel(adminId);
    const receipts = await this.storeReceipts(uploads, payout.organizerId, label);
    const set: Record<string, unknown> = {
      status: 'completed',
      source: input.source,
      resolvedAt: new Date(),
      resolvedByLabel: label,
    };
    // Пустое примечание не затирает текст запроса организатора.
    if (note) set.note = note;
    const updated = await this.payoutModel
      .findOneAndUpdate(
        { id: payoutId, status: 'pending' },
        { $set: set, ...(receipts.length ? { $push: { receipts: { $each: receipts } } } : {}) },
        { new: true },
      )
      .lean<LeanOrganizerPayout>()
      .exec();
    if (!updated) {
      await this.removeMedia(receipts);
      throw bad(FINANCE_ERRORS.payoutNotPending);
    }
    this.logger.log(`Payout PO-${payoutId} completed by ${label} via ${input.source}`);
    return this.mapOne(updated);
  }

  /** Отклонить запрос: только pending, причина ≤ 500. */
  async rejectPayout(payoutId: number, reason: string | null | undefined, adminId: string | number): Promise<FinancePayout> {
    const payout = await this.findPayout(payoutId);
    if (payout.status !== 'pending') throw bad(FINANCE_ERRORS.payoutNotPending);
    const trimmed = (reason ?? '').trim();
    if (trimmed.length > FINANCE_REJECT_REASON_MAX) throw bad(FINANCE_ERRORS.noteTooLong);
    const label = await this.directory.resolveAdminLabel(adminId);
    const updated = await this.payoutModel
      .findOneAndUpdate(
        { id: payoutId, status: 'pending' },
        {
          $set: {
            status: 'failed',
            rejectReason: trimmed || null,
            resolvedAt: new Date(),
            resolvedByLabel: label,
          },
        },
        { new: true },
      )
      .lean<LeanOrganizerPayout>()
      .exec();
    if (!updated) throw bad(FINANCE_ERRORS.payoutNotPending);
    this.logger.log(`Payout PO-${payoutId} rejected by ${label}`);
    return this.mapOne(updated);
  }

  /** Докинуть квитанции к выплате в любом статусе: 1..10 файлов. */
  async addReceipts(
    payoutId: number,
    files: FinanceUploadedFile[] | undefined,
    uploadedBy: { adminId: string | number } | { label: string },
  ): Promise<FinancePayout> {
    const payout = await this.findPayout(payoutId);
    const uploads = this.assertFiles(files);
    if (!uploads.length) throw bad(FINANCE_ERRORS.receiptRequired);
    const label =
      'label' in uploadedBy ? uploadedBy.label : await this.directory.resolveAdminLabel(uploadedBy.adminId);
    const receipts = await this.storeReceipts(uploads, payout.organizerId, label);
    const updated = await this.payoutModel
      .findOneAndUpdate({ id: payoutId }, { $push: { receipts: { $each: receipts } } }, { new: true })
      .lean<LeanOrganizerPayout>()
      .exec();
    if (!updated) {
      await this.removeMedia(receipts);
      throw new NotFoundException(FINANCE_ERRORS.payoutNotFound);
    }
    return this.mapOne(updated);
  }

  /* ------------------------------------------------------------------ */
  /* Внутреннее                                                          */
  /* ------------------------------------------------------------------ */

  private async findPayout(payoutId: number): Promise<LeanOrganizerPayout> {
    const payout = Number.isInteger(payoutId)
      ? await this.payoutModel.findOne({ id: payoutId }).lean<LeanOrganizerPayout>().exec()
      : null;
    if (!payout) throw new NotFoundException(FINANCE_ERRORS.payoutNotFound);
    return payout;
  }

  private async mapOne(row: LeanOrganizerPayout): Promise<FinancePayout> {
    const titles = await this.directory.eventTitles([row.eventId]);
    return toFinancePayout(row, titles.get(row.eventId) ?? `#${row.eventId}`);
  }

  private assertAmount(value: unknown): number {
    const amount = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1e12 || round2(amount) !== amount) {
      throw bad(FINANCE_ERRORS.amountInvalid);
    }
    return amount;
  }

  private normalizeNote(value: string | null | undefined): string {
    const note = (value ?? '').trim();
    if (note.length > FINANCE_NOTE_MAX) throw bad(FINANCE_ERRORS.noteTooLong);
    return note;
  }

  private numericId(value: string | number): number {
    const id = Number(value);
    return Number.isInteger(id) ? id : 0;
  }

  /** Курс для не-THB: из формы (> 0) или посчитанный; нет — 400 `finance_rate_required`. */
  private async resolveRate(
    event: FinanceEventRecord,
    currency: FinanceCurrency,
    bodyRate: number | null | undefined,
  ): Promise<number> {
    if (currency === 'THB') return 1;
    if (bodyRate != null) {
      if (!Number.isFinite(bodyRate) || bodyRate <= 0) throw bad(FINANCE_ERRORS.rateRequired);
      return roundRate(bodyRate) || bodyRate;
    }
    const rates = await this.balances.computeRates(event.id);
    const rate = rates[currency];
    if (rate == null || !(rate > 0)) throw bad(FINANCE_ERRORS.rateRequired);
    return rate;
  }

  /** 0..10 файлов: разрешённый тип, не пустые, ≤ 10 МБ. */
  assertFiles(files: FinanceUploadedFile[] | undefined): FinanceUploadedFile[] {
    const list = (files ?? []).filter(Boolean);
    if (list.length > FINANCE_RECEIPT_MAX_FILES) throw bad(FINANCE_ERRORS.receiptTooMany);
    for (const file of list) {
      if (!isAllowedReceiptMime(file.mimetype)) throw bad(FINANCE_ERRORS.receiptInvalidType);
      const size = file.buffer?.length ?? 0;
      if (!size) throw bad(FINANCE_ERRORS.receiptEmpty);
      if (size > FINANCE_RECEIPT_MAX_BYTES) throw bad(FINANCE_ERRORS.receiptTooLarge);
    }
    return list;
  }

  /** Кладёт файлы приватными медиа владельца события; при сбое удаляет уже созданные. */
  private async storeReceipts(
    files: FinanceUploadedFile[],
    ownerUserId: number,
    uploadedBy: string,
  ): Promise<IOrganizerPayoutReceipt[]> {
    const stored: IOrganizerPayoutReceipt[] = [];
    try {
      for (const file of files) {
        const mimeType = normalizeMime(file.mimetype);
        const mediaId = await this.mediaService.createFromDataUrl(
          `data:${mimeType};base64,${file.buffer.toString('base64')}`,
          ownerUserId,
          mimeType,
          { isPrivate: true },
        );
        stored.push({
          id: mediaId,
          name: sanitizeReceiptName(file.originalname, mimeType),
          mimeType,
          size: file.buffer.length,
          uploadedAt: new Date(),
          uploadedBy,
        });
      }
    } catch (error) {
      await this.removeMedia(stored);
      throw error;
    }
    return stored;
  }

  private async removeMedia(receipts: Array<{ id: number }>): Promise<void> {
    for (const receipt of receipts) {
      try {
        await this.mediaService.removeById(receipt.id);
      } catch (error) {
        this.logger.error(
          `Orphan receipt media ${receipt.id} not removed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}
