import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { MANAGER_ID_KEY } from '../../managers/guards/manager.guard';
import { ManagersService } from '../../managers/managers.service';
import { UserOrManagerGuard } from '../../users/guards/user-or-manager.guard';
import { USER_ID_KEY } from '../../users/guards/user.guard';
import { CreatePayoutRequestDto } from '../dto/create-payout-request.dto';
import { OrganizerFinanceQueryDto } from '../dto/organizer-finance-query.dto';
import { FinanceOrganizerService, OrganizerFinancePrincipal } from '../services/finance-organizer.service';
import { inlineContentDisposition } from '../utils/finance-files.util';

/**
 * Финансы события в кабинете организатора (spec §3). Доступ — организатор или
 * менеджер типа Admin (как весь «полный» дашборд); чужое событие — 404
 * `finance_event_not_found`. Только данные Lotus, без внешних запросов.
 */
@Controller('organizer-finance')
@UseGuards(UserOrManagerGuard(['Admin']))
export class OrganizerFinanceController {
  constructor(
    private readonly organizer: FinanceOrganizerService,
    private readonly managersService: ManagersService,
  ) {}

  /** Тот же порядок проверок, что в mock-sales.controller: назначение менеджера, затем владение (в сервисе). */
  private async principal(req: Request, eventId: number): Promise<OrganizerFinancePrincipal> {
    const managerId = (req as any)[MANAGER_ID_KEY] as string | undefined;
    if (managerId) {
      await this.managersService.assertManagerAssignedToEvent(managerId, eventId);
    }
    return { userId: (req as any)[USER_ID_KEY] as string, managerId: managerId ?? null };
  }

  /** `?sessionId=` — один показ регулярного события. */
  @Get('events/:eventId')
  async getEventFinance(
    @Req() req: Request,
    @Param('eventId', ParseIntPipe) eventId: number,
    @Query() query: OrganizerFinanceQueryDto,
  ) {
    const principal = await this.principal(req, eventId);
    return this.organizer.getEventFinance(eventId, principal.userId, query.sessionId ?? null);
  }

  /** JSON {amount, note?} → OrganizerPayout (pending → inProcess). */
  @Post('events/:eventId/payout-requests')
  async requestPayout(
    @Req() req: Request,
    @Param('eventId', ParseIntPipe) eventId: number,
    @Body() dto: CreatePayoutRequestDto,
  ) {
    const principal = await this.principal(req, eventId);
    return this.organizer.requestPayout(eventId, principal, { amount: dto.amount, note: dto.note });
  }

  /** Файл квитанции выплаты своего события, без кеша. */
  @Get('events/:eventId/payouts/:payoutId/receipts/:receiptId')
  async downloadReceipt(
    @Req() req: Request,
    @Param('eventId', ParseIntPipe) eventId: number,
    @Param('payoutId', ParseIntPipe) payoutId: number,
    @Param('receiptId', ParseIntPipe) receiptId: number,
    @Res() res: Response,
  ) {
    const principal = await this.principal(req, eventId);
    const file = await this.organizer.getReceiptFile(eventId, principal.userId, payoutId, receiptId);
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Disposition', inlineContentDisposition(file.name));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.send(file.buffer);
  }
}
