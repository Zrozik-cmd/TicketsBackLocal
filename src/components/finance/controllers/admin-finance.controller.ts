import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  Res,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { ADMIN_ID_KEY, AdminAuthenticatedRequest, AdminGuard } from '../../admin/guards/admin.guard';
import { CompleteFinancePayoutDto } from '../dto/complete-finance-payout.dto';
import { ConfirmVaultReceiptsDto } from '../dto/confirm-vault-receipts.dto';
import { CreateFinancePayoutDto } from '../dto/create-finance-payout.dto';
import { FinanceFiltersQueryDto } from '../dto/finance-filters-query.dto';
import { FinancePayoutsQueryDto } from '../dto/finance-payouts-query.dto';
import { RejectFinancePayoutDto } from '../dto/reject-finance-payout.dto';
import { FinanceAdminBoardService } from '../services/finance-admin-board.service';
import { FinanceArbiPayBalanceService } from '../services/finance-arbipay-balance.service';
import { FinanceCashService } from '../services/finance-cash.service';
import { FinancePayoutsService } from '../services/finance-payouts.service';
import { FinanceUploadedFile } from '../types/finance.types';
import {
  FINANCE_RECEIPT_MAX_FILES,
  FINANCE_RECEIPT_UPLOAD_OPTIONS,
  inlineContentDisposition,
} from '../utils/finance-files.util';
import { parseFinanceFilter } from '../utils/finance-filters.util';

/**
 * Финансовая доска админки (spec §2). Всё — по данным Lotus, кроме GET provider-balances:
 * живой баланс ARBI Pay через платёжный микросервис (отдельный запрос, чтобы сбой
 * провайдера не ломал доску).
 */
@Controller('admin/finance')
@UseGuards(AdminGuard)
export class AdminFinanceController {
  constructor(
    private readonly board: FinanceAdminBoardService,
    private readonly payouts: FinancePayoutsService,
    private readonly cash: FinanceCashService,
    private readonly providerBalances: FinanceArbiPayBalanceService,
  ) {}

  @Get('events')
  listEvents() {
    return this.board.listEventOptions();
  }

  /** Живой баланс мерчанта ARBI Pay; сбой провайдера — `arbiPay.status: 'unavailable'`, не ошибка. */
  @Get('provider-balances')
  getProviderBalances() {
    return this.providerBalances.getLiveBalances();
  }

  @Get('board')
  getBoard(@Query() query: FinanceFiltersQueryDto) {
    return this.board.getBoard(parseFinanceFilter(query));
  }

  @Get('events/:eventId')
  getEvent(@Param('eventId', ParseIntPipe) eventId: number, @Query() query: FinanceFiltersQueryDto) {
    return this.board.getEventDetails(eventId, parseFinanceFilter(query));
  }

  @Get('events/:eventId/payout-context')
  getPayoutContext(@Param('eventId', ParseIntPipe) eventId: number) {
    return this.board.getPayoutContext(eventId);
  }

  /** multipart: type, amount, currency, rateToThb?, source, note?, files[] (1..10, ≤ 10 МБ). */
  @Post('events/:eventId/payouts')
  @UseInterceptors(FilesInterceptor('files', FINANCE_RECEIPT_MAX_FILES, FINANCE_RECEIPT_UPLOAD_OPTIONS))
  createPayout(
    @Req() req: AdminAuthenticatedRequest,
    @Param('eventId', ParseIntPipe) eventId: number,
    @Body() dto: CreateFinancePayoutDto,
    @UploadedFiles() files?: FinanceUploadedFile[],
  ) {
    return this.payouts.createAdminPayout(
      eventId,
      {
        type: dto.type,
        amount: dto.amount,
        currency: dto.currency,
        rateToThb: dto.rateToThb ?? null,
        source: dto.source,
        note: dto.note ?? '',
      },
      files,
      req[ADMIN_ID_KEY],
    );
  }

  @Get('payouts')
  listPayouts(@Query() query: FinancePayoutsQueryDto) {
    return this.payouts.listPayouts(query.status ?? null);
  }

  /** multipart: files[] (1..10) — к выплате в любом статусе. */
  @Post('payouts/:payoutId/receipts')
  @UseInterceptors(FilesInterceptor('files', FINANCE_RECEIPT_MAX_FILES, FINANCE_RECEIPT_UPLOAD_OPTIONS))
  addReceipts(
    @Req() req: AdminAuthenticatedRequest,
    @Param('payoutId', ParseIntPipe) payoutId: number,
    @UploadedFiles() files?: FinanceUploadedFile[],
  ) {
    return this.payouts.addReceipts(payoutId, files, { adminId: req[ADMIN_ID_KEY] });
  }

  /** multipart: source, note?, files[]? — провести запрос (только pending). */
  @Post('payouts/:payoutId/complete')
  @HttpCode(200)
  @UseInterceptors(FilesInterceptor('files', FINANCE_RECEIPT_MAX_FILES, FINANCE_RECEIPT_UPLOAD_OPTIONS))
  completePayout(
    @Req() req: AdminAuthenticatedRequest,
    @Param('payoutId', ParseIntPipe) payoutId: number,
    @Body() dto: CompleteFinancePayoutDto,
    @UploadedFiles() files?: FinanceUploadedFile[],
  ) {
    return this.payouts.completePayout(payoutId, { source: dto.source, note: dto.note }, files, req[ADMIN_ID_KEY]);
  }

  /** JSON {reason?} — отклонить запрос (только pending). */
  @Post('payouts/:payoutId/reject')
  @HttpCode(200)
  rejectPayout(
    @Req() req: AdminAuthenticatedRequest,
    @Param('payoutId', ParseIntPipe) payoutId: number,
    @Body() dto: RejectFinancePayoutDto,
  ) {
    return this.payouts.rejectPayout(payoutId, dto.reason, req[ADMIN_ID_KEY]);
  }

  /** Файл квитанции: только из этой выплаты, без кеша. */
  @Get('payouts/:payoutId/receipts/:receiptId')
  async downloadReceipt(
    @Param('payoutId', ParseIntPipe) payoutId: number,
    @Param('receiptId', ParseIntPipe) receiptId: number,
    @Res() res: Response,
  ) {
    const file = await this.payouts.getReceiptFile(payoutId, receiptId);
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Disposition', inlineContentDisposition(file.name));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.send(file.buffer);
  }

  @Get('cash/in-transit')
  listInTransit() {
    return this.cash.listInTransit();
  }

  /** JSON {ledgerEntryIds, note?} → {confirmed}. Идемпотентно. */
  @Post('cash/vault-receipts')
  @HttpCode(200)
  confirmVaultReceipts(@Req() req: AdminAuthenticatedRequest, @Body() dto: ConfirmVaultReceiptsDto) {
    return this.cash.confirmVaultReceipts(req[ADMIN_ID_KEY], dto.ledgerEntryIds, dto.note);
  }
}
