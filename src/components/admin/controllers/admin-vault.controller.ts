import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  ADMIN_ID_KEY,
  AdminGuard,
  type AdminAuthenticatedRequest,
} from "../guards/admin.guard";
import { AdminVaultEventsQueryDto } from "../dto/admin-vault-events-query.dto";
import { AdminVaultTicketSearchQueryDto } from "../dto/admin-vault-ticket-search-query.dto";
import {
  RemoveTicketsDto,
  TicketRemovalPreviewDto,
} from "../dto/remove-tickets.dto";
import { AdminVaultEventsService } from "../services/admin-vault-events.service";
import { AdminVaultTicketsService } from "../services/admin-vault-tickets.service";
import { AdminTicketRemovalService } from "../services/admin-ticket-removal.service";

/**
 * Service tools of the admin panel (hidden page `/admin/vault`): event cleanup overview
 * and silent ticket removal. Same AdminGuard as the rest of the admin API.
 */
@Controller("admin/vault")
@UseGuards(AdminGuard)
export class AdminVaultController {
  constructor(
    private readonly vaultEventsService: AdminVaultEventsService,
    private readonly vaultTicketsService: AdminVaultTicketsService,
    private readonly ticketRemovalService: AdminTicketRemovalService,
  ) {}

  @Get("events")
  getEvents(@Query() query: AdminVaultEventsQueryDto) {
    return this.vaultEventsService.listEvents(query);
  }

  @Get("tickets")
  searchTickets(@Query() query: AdminVaultTicketSearchQueryDto) {
    return this.vaultTicketsService.search(query);
  }

  @Post("tickets/removal-preview")
  @HttpCode(200)
  getTicketRemovalPreview(@Body() body: TicketRemovalPreviewDto) {
    return this.ticketRemovalService.getPreview(body.ticketIds);
  }

  @Post("tickets/remove")
  @HttpCode(200)
  removeTickets(
    @Req() req: AdminAuthenticatedRequest,
    @Body() body: RemoveTicketsDto,
  ) {
    return this.ticketRemovalService.remove(
      body.ticketIds,
      body.confirmation,
      body.expectedOrderUpdatedAt,
      req[ADMIN_ID_KEY],
    );
  }
}
