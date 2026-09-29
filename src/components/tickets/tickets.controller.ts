import { Body, Controller, Get, Param, ParseIntPipe, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { TicketsService } from './tickets.service';
import { CustomerGuard, CUSTOMER_ID_KEY } from '../customers/guards/customer.guard';
import { ManagerGuard, MANAGER_ID_KEY } from '../managers/guards/manager.guard';
import { ScanTicketDto } from './dto/scan-ticket.dto';

@Controller('tickets')
export class TicketsController {
  constructor(private readonly ticketsService: TicketsService) {}

  @Get('order/:orderId')
  @UseGuards(CustomerGuard)
  getByOrder(@Req() req: Request, @Param('orderId', ParseIntPipe) orderId: number) {
    const customerId = Number((req as any)[CUSTOMER_ID_KEY]);
    return this.ticketsService.findByOrderForCustomer(orderId, customerId);
  }

  @Get('my')
  @UseGuards(CustomerGuard)
  getMyTickets(@Req() req: Request) {
    const customerId = Number((req as any)[CUSTOMER_ID_KEY]);
    return this.ticketsService.findAllForCustomer(customerId);
  }

  @Get('scanner/event-structure/:eventId')
  @UseGuards(ManagerGuard(['Cashier']))
  getScannerEventStructure(@Req() req: Request, @Param('eventId', ParseIntPipe) eventId: number) {
    const managerId = Number((req as any)[MANAGER_ID_KEY]);
    return this.ticketsService.getScannerEventStructure(eventId, managerId);
  }

  @Post('scanner/scan')
  @UseGuards(ManagerGuard(['Cashier']))
  scanTicket(@Req() req: Request, @Body() dto: ScanTicketDto) {
    const managerId = Number((req as any)[MANAGER_ID_KEY]);
    return this.ticketsService.scanTicketByCode(dto.eventId, managerId, dto.code);
  }
}
