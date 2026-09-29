import { Controller, Get, Param, ParseIntPipe, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { EventsService } from './events.service';
import { USER_ID_KEY } from '../users/guards/user.guard';
import { UserOrManagerGuard } from '../users/guards/user-or-manager.guard';
import { MANAGER_ID_KEY } from '../managers/guards/manager.guard';
import { ManagersService } from '../managers/managers.service';

@Controller('events/private')
export class EventsPrivateController {
  constructor(
    private readonly eventsService: EventsService,
    private readonly managersService: ManagersService,
  ) {}

  /**
   * Numeric event id. Only the owning organizer can read statistics. ParseIntPipe keeps
   * the manager-assignment check and the look-up on the same integer (`13abc` must not
   * skip the check and still resolve to event 13).
   */
  @UseGuards(UserOrManagerGuard(['Admin', 'Marketing']))
  @Get(':id/statistics')
  async getStatistics(@Req() req: Request, @Param('id', ParseIntPipe) id: number) {
    const managerId = (req as any)[MANAGER_ID_KEY] as string | undefined;
    if (managerId) {
      await this.managersService.assertManagerAssignedToEvent(managerId, id);
    }
    return this.eventsService.getOwnerEventStatistics(String(id), (req as any)[USER_ID_KEY] as string);
  }

  /**
   * Edit form pre-check of a regular event: `{ timesLocked, sessions }` — whether the show
   * times are fixed and every show with sold tickets (paid, not refunded, plus active cash
   * bookings). Same guard as the event update route (`PATCH /events/:id`) plus ownership.
   */
  @UseGuards(UserOrManagerGuard(['Admin']))
  @Get(':id/sessions/sales-summary')
  getSessionSalesSummary(@Req() req: Request, @Param('id', ParseIntPipe) id: number) {
    return this.eventsService.getOwnerSessionSalesSummary(id, (req as any)[USER_ID_KEY] as string);
  }
}
