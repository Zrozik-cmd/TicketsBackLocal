import { Controller, Get, Param, ParseIntPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { CashOrdersService } from './cash-orders.service';
import { CashOrdersQueryDto } from './dto/cash-orders-query.dto';
import {
  CASH_ORDERS_ACTOR_KEY,
  CashOrdersActor,
  CashOrdersAccessGuard,
} from './guards/cash-orders-access.guard';

@Controller('cash-orders')
@UseGuards(CashOrdersAccessGuard)
export class CashOrdersController {
  constructor(private readonly cashOrdersService: CashOrdersService) {}

  @Get()
  list(@Query() query: CashOrdersQueryDto, @Req() req: Request) {
    const actor = (req as unknown as Record<string, CashOrdersActor>)[CASH_ORDERS_ACTOR_KEY];
    return this.cashOrdersService.listCashOrders(query, actor);
  }

  /**
   * Booking lookup for the mobile till: the value scanned from the customer's
   * QR or typed by hand. Same access rules as every other cash-orders route.
   */
  @Get('lookup/:code')
  lookup(
    @Param('code') code: string,
    @Req() req: Request,
    @Query('source') source?: string,
  ) {
    const actor = (req as unknown as Record<string, CashOrdersActor>)[CASH_ORDERS_ACTOR_KEY];
    return this.cashOrdersService.findCashOrderByCode(
      code,
      actor,
      source === 'manual' ? 'manual' : 'scan',
    );
  }

  @Get(':id')
  details(@Param('id', ParseIntPipe) id: number) {
    return this.cashOrdersService.getCashOrderDetails(id);
  }

  @Post(':id/confirm')
  confirm(@Req() req: Request, @Param('id', ParseIntPipe) id: number) {
    const actor = (req as any)[CASH_ORDERS_ACTOR_KEY] as CashOrdersActor;
    return this.cashOrdersService.confirmCashOrder(id, actor);
  }

  @Post(':id/extend')
  extend(@Req() req: Request, @Param('id', ParseIntPipe) id: number) {
    const actor = (req as any)[CASH_ORDERS_ACTOR_KEY] as CashOrdersActor;
    return this.cashOrdersService.extendExpiredCashOrder(id, actor);
  }

  @Post(':id/reissue')
  reissue(@Req() req: Request, @Param('id', ParseIntPipe) id: number) {
    const actor = (req as any)[CASH_ORDERS_ACTOR_KEY] as CashOrdersActor;
    return this.cashOrdersService.reissueExpiredCashOrder(id, actor);
  }

  @Post(':id/cancel')
  cancel(@Req() req: Request, @Param('id', ParseIntPipe) id: number) {
    const actor = (req as any)[CASH_ORDERS_ACTOR_KEY] as CashOrdersActor;
    return this.cashOrdersService.cancelCashOrderByStaff(id, actor);
  }
}
