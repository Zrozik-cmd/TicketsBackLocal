import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import {
  CASH_ORDERS_ACTOR_KEY,
  CashOrdersActor,
  CashOrdersAccessGuard,
} from '../../cash-orders/guards/cash-orders-access.guard';
import { CashEncashmentsService } from '../cash-encashments.service';
import { CreateAdjustmentDto } from '../dto/create-adjustment.dto';
import { CreateEncashmentDto } from '../dto/create-encashment.dto';
import { ResetTillDto } from '../dto/reset-till.dto';
import { CashSeriesQueryDto } from '../dto/cash-series-query.dto';
import { PosStatsQueryDto } from '../dto/pos-stats-query.dto';
import { ScansQueryDto } from '../dto/scans-query.dto';
import {
  CashStatsSummaryQueryDto,
  EncashmentsQueryDto,
} from '../dto/encashments-query.dto';

/**
 * Статистика кассира и инкассации. Кассир видит и меняет только своё;
 * админ читает любого кассира через ?cashierId= (выбор субъекта — в сервисе).
 */
@Controller('cash-stats')
@UseGuards(CashOrdersAccessGuard)
export class CashStatsController {
  constructor(private readonly cashEncashmentsService: CashEncashmentsService) {}

  private actor(req: Request): CashOrdersActor {
    return (req as unknown as Record<string, CashOrdersActor>)[CASH_ORDERS_ACTOR_KEY];
  }

  @Get('summary')
  summary(@Req() req: Request, @Query() query: CashStatsSummaryQueryDto) {
    return this.cashEncashmentsService.getSummary(this.actor(req), query.cashierId);
  }

  @Get('encashments')
  encashments(@Req() req: Request, @Query() query: EncashmentsQueryDto) {
    return this.cashEncashmentsService.listEncashments(this.actor(req), query);
  }

  @Post('encashments')
  createEncashment(@Req() req: Request, @Body() dto: CreateEncashmentDto) {
    return this.cashEncashmentsService.createEncashment(this.actor(req), dto);
  }

  /** Корректировка кассы (только админ): плюс/минус с обязательной причиной. */
  @Post('adjustments')
  createAdjustment(@Req() req: Request, @Body() dto: CreateAdjustmentDto) {
    const actor = this.actor(req);
    if (actor.type !== 'Admin') {
      throw new ForbiddenException('admin_only');
    }
    return this.cashEncashmentsService.createAdjustment(actor, dto);
  }

  /**
   * Обнуление кассы кассира (только админ). Пишется в журнал отдельной
   * строкой с автором и причиной — операция не бесследная.
   */
  @Post('reset')
  resetTill(@Req() req: Request, @Body() dto: ResetTillDto) {
    const actor = this.actor(req);
    if (actor.type !== 'Admin') {
      throw new ForbiddenException('admin_only');
    }
    return this.cashEncashmentsService.resetTill(actor, dto);
  }

  /** Журнал проверок броней: что кассир сканировал или искал по коду. */
  @Get('scans')
  scans(@Req() req: Request, @Query() query: ScansQueryDto) {
    return this.cashEncashmentsService.listScans(this.actor(req), query);
  }

  /** Справочник имён для модалки инкассации — нужен и кассиру. */
  @Get('collectors')
  collectors() {
    return this.cashEncashmentsService.listCollectors();
  }

  /** Сводка по точкам продаж: выручка, касса, инкассации. Только админ. */
  @Get('pos')
  posStats(@Req() req: Request, @Query() query: PosStatsQueryDto) {
    if (this.actor(req).type !== 'Admin') {
      throw new ForbiddenException('admin_only');
    }
    return this.cashEncashmentsService.getPosStats(query);
  }

  /** Ряды для графиков: выручка и инкассации по времени. Кассиру — свои. */
  @Get('series')
  series(@Req() req: Request, @Query() query: CashSeriesQueryDto) {
    return this.cashEncashmentsService.getSeries(this.actor(req), query);
  }

  @Get('overview')
  overview(@Req() req: Request) {
    if (this.actor(req).type !== 'Admin') {
      throw new ForbiddenException('admin_only');
    }
    return this.cashEncashmentsService.getOverview();
  }
}
