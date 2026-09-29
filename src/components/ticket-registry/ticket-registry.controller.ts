import { Controller, Get, Param, ParseIntPipe, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { TicketRegistryService } from './ticket-registry.service';
import { SessionOrdersService } from './session-orders.service';
import { TicketPdfQueryDto, TicketRegistryQueryDto } from './dto/ticket-registry.dto';
import { SessionOrdersQueryDto } from './dto/session-orders.dto';
import { UserOrManagerGuard } from '../users/guards/user-or-manager.guard';
import { USER_ID_KEY } from '../users/guards/user.guard';
import { MANAGER_ID_KEY } from '../managers/guards/manager.guard';
import { ManagersService } from '../managers/managers.service';

/**
 * Organizer ticket registry. Same access rule as GET /events/private/:id/statistics:
 * the owning organizer, or one of their managers (a Marketing manager only for events
 * assigned to them). Lives in its own module because the PDF needs the puppeteer
 * service, which itself depends on EventsModule.
 *
 * `:id` goes through ParseIntPipe: the assignment check and the event look-up must read
 * the very same integer (`13abc`, `13.5` or `1e1` would otherwise slip past the check
 * while the look-up still resolved to an event of the organizer).
 */
@Controller('events/private')
@UseGuards(UserOrManagerGuard(['Admin', 'Marketing']))
export class TicketRegistryController {
  constructor(
    private readonly ticketRegistryService: TicketRegistryService,
    private readonly sessionOrdersService: SessionOrdersService,
    private readonly managersService: ManagersService,
  ) {}

  private async assertManagerAssigned(req: Request, eventId: number): Promise<void> {
    const managerId = (req as any)[MANAGER_ID_KEY] as string | undefined;
    if (managerId) {
      await this.managersService.assertManagerAssignedToEvent(managerId, eventId);
    }
  }

  /** Every ticket of the event: search, status / session / show-date filters, paging. */
  @Get(':id/tickets-registry')
  async getTicketsRegistry(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
    @Query() query: TicketRegistryQueryDto,
  ) {
    await this.assertManagerAssigned(req, id);
    return this.ticketRegistryService.getRegistry(id, (req as any)[USER_ID_KEY] as string, query);
  }

  /**
   * Orders of one session with buyer contacts, payment / refund data, the session's
   * tickets and — for a cancelled session — the cancellation letter's state.
   */
  @Get(':id/sessions/:sessionId/orders')
  async getSessionOrders(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @Query() query: SessionOrdersQueryDto,
  ) {
    await this.assertManagerAssigned(req, id);
    return this.sessionOrdersService.getSessionOrders(
      id,
      sessionId,
      (req as any)[USER_ID_KEY] as string,
      query,
    );
  }

  /** The ticket as a PDF download (same design as the e-mailed ticket). */
  @Get(':id/tickets/:ticketId/pdf')
  async getTicketPdf(
    @Req() req: Request,
    @Res() res: Response,
    @Param('id', ParseIntPipe) id: number,
    @Param('ticketId', ParseIntPipe) ticketId: number,
    @Query() query: TicketPdfQueryDto,
  ) {
    await this.assertManagerAssigned(req, id);
    const { buffer, filename } = await this.ticketRegistryService.getTicketPdf(
      id,
      (req as any)[USER_ID_KEY] as string,
      ticketId,
      query.locale ?? 'en',
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', String(buffer.length));
    // A ticket carries a buyer's personal data and a valid entry code.
    res.setHeader('Cache-Control', 'no-store');
    return res.send(buffer);
  }
}
