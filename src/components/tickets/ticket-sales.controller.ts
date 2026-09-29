import { Controller, Get, Param, ParseIntPipe, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { EventsService } from '../events/events.service';
import { SessionPeriodFilterQueryDto } from '../events/dto/session-period-filter.dto';
import { UserOrManagerGuard } from '../users/guards/user-or-manager.guard';
import { USER_ID_KEY } from '../users/guards/user.guard';
import { MANAGER_ID_KEY } from '../managers/guards/manager.guard';
import { ManagersService } from '../managers/managers.service';

@Controller('tickets/sales')
@UseGuards(UserOrManagerGuard(['Admin', 'Marketing']))
export class TicketSalesController {
  constructor(
    private readonly eventsService: EventsService,
    private readonly managersService: ManagersService,
  ) {}

  /** Optional `from`/`to` (ICT show dates, inclusive) and `sessionId` narrow it to those shows. */
  @Get('events/:eventId/statistics')
  async getEventTicketStatistics(
    @Req() req: Request,
    @Param('eventId', ParseIntPipe) eventId: number,
    @Query() query: SessionPeriodFilterQueryDto,
  ) {
    const managerId = (req as any)[MANAGER_ID_KEY] as string | undefined;
    if (managerId) {
      await this.managersService.assertManagerAssignedToEvent(managerId, eventId);
    }
    const creatorUserId = (req as any)[USER_ID_KEY] as string;
    return this.eventsService.getEventTicketSalesStatistics(eventId, creatorUserId, query);
  }
}
