import {
  Controller,
  Get,
  Header,
  Param,
  ParseIntPipe,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import { Response } from "express";
import { AdminGuard } from "../guards/admin.guard";
import { AdminOrCashierArbiGuard } from "../guards/admin-or-cashier-arbi.guard";
import { EventsService } from "../../events/events.service";
import { SessionPeriodFilterQueryDto } from "../../events/dto/session-period-filter.dto";
import { MockOrdersService } from "../../mock-orders/mock-orders.service";
import { MockOrdersPaidListQueryDto } from "../../mock-orders/dto/mock-orders-event-paid-list.dto";
import { TicketRegistryService } from "../../ticket-registry/ticket-registry.service";
import { SessionOrdersService } from "../../ticket-registry/session-orders.service";
import {
  TicketPdfQueryDto,
  TicketRegistryQueryDto,
} from "../../ticket-registry/dto/ticket-registry.dto";
import { SessionOrdersQueryDto } from "../../ticket-registry/dto/session-orders.dto";

/**
 * Event statistics for admins: same payloads as organizer-facing routes
 * (EventsPrivateController, TicketSalesController, MockSalesController,
 * TicketRegistryController) but without creator ownership checks — any existing
 * event id is allowed. Read-only: nothing here changes a session or an order.
 * Ticket sales statistics is also available to CashierArbi.
 */
@Controller("admin/event-statistics")
export class AdminEventStatisticsController {
  constructor(
    private readonly eventsService: EventsService,
    private readonly mockOrdersService: MockOrdersService,
    private readonly ticketRegistryService: TicketRegistryService,
    private readonly sessionOrdersService: SessionOrdersService,
  ) {}

  /** Mirrors GET events/private/:id/statistics */
  @Get("events/private/:id/statistics")
  @UseGuards(AdminGuard)
  getOwnerStyleStatistics(@Param("id") id: string) {
    return this.eventsService.getAdminEventStatistics(id);
  }

  /**
   * Mirrors GET events/private/:id/tickets-registry (search, status / session /
   * show-date filters, paging). The organizer's registry service is called with the
   * event's own creator, so the admin sees exactly what the organizer sees.
   */
  @Get("events/private/:id/tickets-registry")
  @UseGuards(AdminGuard)
  async getTicketsRegistry(
    @Param("id", ParseIntPipe) id: number,
    @Query() query: TicketRegistryQueryDto,
  ) {
    const creatorId = await this.eventsService.findEventCreatorId(id);
    return this.ticketRegistryService.getRegistry(id, creatorId, query);
  }

  /** Mirrors GET events/private/:id/sessions/:sessionId/orders (buyers of one session). */
  @Get("events/private/:id/sessions/:sessionId/orders")
  @UseGuards(AdminGuard)
  async getSessionOrders(
    @Param("id", ParseIntPipe) id: number,
    @Param("sessionId", ParseIntPipe) sessionId: number,
    @Query() query: SessionOrdersQueryDto,
  ) {
    const creatorId = await this.eventsService.findEventCreatorId(id);
    return this.sessionOrdersService.getSessionOrders(id, sessionId, creatorId, query);
  }

  /** Mirrors GET events/private/:id/tickets/:ticketId/pdf (same headers). */
  @Get("events/private/:id/tickets/:ticketId/pdf")
  @UseGuards(AdminGuard)
  async getTicketPdf(
    @Res() res: Response,
    @Param("id", ParseIntPipe) id: number,
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Query() query: TicketPdfQueryDto,
  ) {
    const creatorId = await this.eventsService.findEventCreatorId(id);
    const { buffer, filename } = await this.ticketRegistryService.getTicketPdf(
      id,
      creatorId,
      ticketId,
      query.locale ?? "en",
    );
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Length", String(buffer.length));
    // A ticket carries a buyer's personal data and a valid entry code.
    res.setHeader("Cache-Control", "no-store");
    return res.send(buffer);
  }

  /**
   * Mirrors GET tickets/sales/events/:eventId/statistics, including the optional
   * `from`/`to` (ICT show dates, inclusive) and `sessionId`.
   */
  @Get("tickets/sales/events/:eventId/statistics")
  @UseGuards(AdminOrCashierArbiGuard)
  getTicketSalesStatistics(
    @Param("eventId", ParseIntPipe) eventId: number,
    @Query() query: SessionPeriodFilterQueryDto,
  ) {
    return this.eventsService.getAdminEventTicketSalesStatistics(eventId, query);
  }

  /**
   * Mirrors GET mock-orders/sales/events/:eventId/statistics, including the optional
   * `from`/`to` (ICT show dates, inclusive) and `sessionId`.
   */
  @Get("mock-orders/sales/events/:eventId/statistics")
  @UseGuards(AdminGuard)
  getMockPaidSalesStatistics(
    @Param("eventId", ParseIntPipe) eventId: number,
    @Query() query: SessionPeriodFilterQueryDto,
  ) {
    return this.mockOrdersService.getEventPaidSalesStatisticsAdmin(eventId, query);
  }

  /** Mirrors GET mock-orders/sales/events/:eventId/paid-orders (`from`/`to`/`sessionId` included). */
  @Get("mock-orders/sales/events/:eventId/paid-orders")
  @UseGuards(AdminGuard)
  getMockPaidOrdersPaged(
    @Param("eventId", ParseIntPipe) eventId: number,
    @Query() query: MockOrdersPaidListQueryDto,
  ) {
    return this.mockOrdersService.findPaidMockOrdersForEventPagedAdmin(
      eventId,
      query,
    );
  }

  /** CSV export for paid/refunded orders (Excel-compatible). Financial totals exclude refunded orders via statistics API. */
  @Get("mock-orders/sales/events/:eventId/paid-orders/export")
  @UseGuards(AdminGuard)
  @Header("Content-Type", "text/csv; charset=utf-8")
  @Header("Content-Disposition", 'attachment; filename="event-orders-export.csv"')
  async exportMockPaidOrders(
    @Param("eventId", ParseIntPipe) eventId: number,
  ): Promise<string> {
    return this.mockOrdersService.exportPaidMockOrdersCsvForEventAdmin(eventId);
  }
}
