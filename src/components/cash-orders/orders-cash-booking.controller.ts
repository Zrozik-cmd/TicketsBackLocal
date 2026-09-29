import { Body, Controller, Param, ParseIntPipe, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { CUSTOMER_ID_KEY, CustomerGuard } from '../customers/guards/customer.guard';
import { BookCashOrderDto } from './dto/book-cash-order.dto';
import { CashOrdersService } from './cash-orders.service';

@Controller('orders')
export class OrdersCashBookingController {
  constructor(private readonly cashOrdersService: CashOrdersService) {}

  @Post('book-cash')
  @UseGuards(CustomerGuard)
  bookCash(@Req() req: Request, @Body() dto: BookCashOrderDto) {
    const customerId = Number((req as any)[CUSTOMER_ID_KEY]);
    return this.cashOrdersService.bookCashOrder(dto, customerId);
  }

  @Post(':id/cancel-cash')
  @UseGuards(CustomerGuard)
  cancelCash(@Req() req: Request, @Param('id', ParseIntPipe) id: number) {
    const customerId = Number((req as any)[CUSTOMER_ID_KEY]);
    return this.cashOrdersService.cancelCashOrder(id, customerId);
  }
}
