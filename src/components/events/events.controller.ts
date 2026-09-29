import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Req,
  UseGuards,
  Query,
  HttpCode,
  ParseIntPipe,
} from '@nestjs/common';
import { Request } from 'express';
import { EventsService } from './events.service';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import {
  BulkUpdateSessionStatusDto,
  UpdateSessionStatusDto,
} from './dto/update-session-status.dto';
import { UpdateEventVisibilityDto } from './dto/update-event-visibility.dto';
import { UpdateEventCashPaymentDto } from './dto/update-event-cash-payment.dto';
import { SendPhoneCodeDto } from '../users/dto/send-code.dto';
import { VerifyPhoneCodeDto } from '../users/dto/verify-code.dto';
import { USER_ID_KEY } from '../users/guards/user.guard';
import { UserOrManagerGuard } from '../users/guards/user-or-manager.guard';
import { MANAGER_ID_KEY } from '../managers/guards/manager.guard';
import { ManagersService } from '../managers/managers.service';
import { EventRemovalService } from './event-removal.service';
import { RemoveEventDto } from './dto/remove-event.dto';
import { keepPlanSectors } from '../seating-plan/utils/plan-sectors.util';
import { currentEventSectors } from '../seating-plan/plan-sectors';

@Controller('events')
export class EventsController {
  constructor(
    private readonly eventsService: EventsService,
    private readonly managersService: ManagersService,
    private readonly eventRemovalService: EventRemovalService,
  ) {}

  @UseGuards(UserOrManagerGuard(['Admin']))
  @Post()
  create(@Req() req: Request, @Body() createEventDto: CreateEventDto) {
    return this.eventsService.create(createEventDto, (req as any)[USER_ID_KEY] as string);
  }

  @UseGuards(UserOrManagerGuard(['Admin', 'Marketing']))
  @Get()
  async findAll(
    @Req() req: Request,
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('archived') archived?: string,
  ) {
    const userId = (req as any)[USER_ID_KEY] as string;
    const managerId = (req as any)[MANAGER_ID_KEY] as string | undefined;
    // Organizer archive: `only` / `exclude`; anything else (or absent) lists every event.
    const archivedFilter = archived === 'only' || archived === 'exclude' ? archived : undefined;

    if (!managerId) {
      return this.eventsService.findAll(userId, status, search, undefined, archivedFilter);
    }

    const manager = await this.managersService.findById(managerId);
    if (!manager || manager.type !== 'Marketing') {
      return this.eventsService.findAll(userId, status, search, undefined, archivedFilter);
    }
    const assignedEvents = await this.managersService.getAssignedEventIds(managerId);
    return this.eventsService.findAll(userId, status, search, assignedEvents, archivedFilter);
  }

  @UseGuards(UserOrManagerGuard(['Admin']))
  @Post('payment-phone/send-code')
  sendPaymentPhoneCode(@Body() dto: SendPhoneCodeDto) {
    return this.eventsService.sendPaymentPhoneCode(dto.phoneNumber);
  }

  @UseGuards(UserOrManagerGuard(['Admin']))
  @Post('payment-phone/verify-code')
  verifyPaymentPhoneCode(@Body() dto: VerifyPhoneCodeDto) {
    return this.eventsService.verifyPaymentPhoneCode(dto.phoneNumber, dto.code);
  }

  /** ParseIntPipe: the manager-assignment check and the look-up read the same integer. */
  @UseGuards(UserOrManagerGuard(['Admin', 'Marketing']))
  @Get(':id')
  async findOne(@Req() req: Request, @Param('id', ParseIntPipe) id: number) {
    const managerId = (req as any)[MANAGER_ID_KEY] as string | undefined;
    if (managerId) {
      await this.managersService.assertManagerAssignedToEvent(managerId, id);
    }
    return this.eventsService.findOne(String(id), (req as any)[USER_ID_KEY] as string);
  }

  /** Organizer cabinet: every generated session of a regular event, disabled ones included. */
  @UseGuards(UserOrManagerGuard(['Admin', 'Marketing']))
  @Get(':id/sessions')
  async getSessions(@Req() req: Request, @Param('id') id: string) {
    const managerId = (req as any)[MANAGER_ID_KEY] as string | undefined;
    const eventId = Number(id);
    if (managerId && Number.isInteger(eventId)) {
      await this.managersService.assertManagerAssignedToEvent(managerId, eventId);
    }
    return this.eventsService.getOwnerSessions(eventId, (req as any)[USER_ID_KEY] as string);
  }

  /**
   * Sell out, reopen or cancel many sessions of a regular event at once. Same guard and
   * ownership rule as the single-session PATCH below; no re-moderation.
   */
  @UseGuards(UserOrManagerGuard(['Admin']))
  @Post(':id/sessions/bulk-status')
  @HttpCode(200)
  bulkSetSessionStatus(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: BulkUpdateSessionStatusDto,
  ) {
    return this.eventsService.bulkSetSessionStatus(
      Number(id),
      dto.sessionIds,
      dto.status,
      (req as any)[USER_ID_KEY] as string,
    );
  }

  /** Sell out, reopen or cancel a single session without touching the whole event. */
  @UseGuards(UserOrManagerGuard(['Admin']))
  @Patch(':id/sessions/:sessionId')
  setSessionStatus(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('sessionId') sessionId: string,
    @Body() dto: UpdateSessionStatusDto,
  ) {
    return this.eventsService.setSessionStatus(
      Number(id),
      Number(sessionId),
      dto.status,
      (req as any)[USER_ID_KEY] as string,
    );
  }

  /**
   * Hide the event from the public site or return it (`{ hidden: boolean }`). The
   * organizer or their Admin manager; a separate switch — never the status, never
   * moderation. ParseIntPipe: a malformed id is a 400, not a look-up of `NaN`.
   */
  @UseGuards(UserOrManagerGuard(['Admin']))
  @Patch(':id/visibility')
  setVisibility(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateEventVisibilityDto,
  ) {
    return this.eventsService.setHiddenFromSite(id, dto.hidden, {
      userId: (req as any)[USER_ID_KEY] as string,
      managerId: (req as any)[MANAGER_ID_KEY] as string | undefined,
    });
  }

  /**
   * Cash payment on/off for an owned event (organizer or their Admin manager). Applies
   * immediately whatever the status — never a moderation change.
   */
  @UseGuards(UserOrManagerGuard(['Admin']))
  @Patch(':id/cash-payment')
  setCashPayment(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateEventCashPaymentDto,
  ) {
    return this.eventsService.setCashPayment(id, dto.enabled, {
      userId: (req as any)[USER_ID_KEY] as string,
      managerId: (req as any)[MANAGER_ID_KEY] as string | undefined,
    });
  }

  @UseGuards(UserOrManagerGuard(['Admin']))
  @Patch(':id')
  async update(@Req() req: Request, @Param('id') id: string, @Body() updateEventDto: UpdateEventDto) {
    // Секторы схемы зала пишет только её публикация — сохранение формы их не трогает
    if (Array.isArray(updateEventDto.sectors)) {
      updateEventDto.sectors = keepPlanSectors(updateEventDto.sectors, await currentEventSectors(Number(id))) as any;
    }
    return this.eventsService.update(id, updateEventDto, (req as any)[USER_ID_KEY] as string);
  }

  /**
   * Preflight of the organizer "delete event" dialog: whether removal deletes the event
   * (no sales) or moves it to the archive (sales), with the reasons and counts.
   */
  @UseGuards(UserOrManagerGuard(['Admin']))
  @Get(':id/removal-check')
  getRemovalCheck(@Req() req: Request, @Param('id', ParseIntPipe) id: number) {
    return this.eventRemovalService.getRemovalCheck(id, (req as any)[USER_ID_KEY] as string);
  }

  /**
   * Delete (no sales) or archive (sales) an owned event. `expect` is the outcome the
   * dialog showed: 409 `event_removal_outcome_changed` when it is no longer the one.
   */
  @UseGuards(UserOrManagerGuard(['Admin']))
  @Post(':id/remove')
  @HttpCode(200)
  removeWithCheck(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RemoveEventDto,
  ) {
    return this.eventRemovalService.remove(
      id,
      {
        userId: (req as any)[USER_ID_KEY] as string,
        managerId: (req as any)[MANAGER_ID_KEY] as string | undefined,
      },
      dto.expect,
    );
  }

  /** Return an archived event (flag only: no status change, no moderation). */
  @UseGuards(UserOrManagerGuard(['Admin']))
  @Post(':id/restore')
  @HttpCode(200)
  restore(@Req() req: Request, @Param('id', ParseIntPipe) id: number) {
    return this.eventRemovalService.restore(id, {
      userId: (req as any)[USER_ID_KEY] as string,
      managerId: (req as any)[MANAGER_ID_KEY] as string | undefined,
    });
  }

  /**
   * Legacy delete: never a blind delete any more — the safe outcome is chosen server-side
   * (an event with sales is archived, not deleted).
   */
  @UseGuards(UserOrManagerGuard(['Admin']))
  @Delete(':id')
  remove(@Req() req: Request, @Param('id', ParseIntPipe) id: number) {
    return this.eventRemovalService.remove(id, {
      userId: (req as any)[USER_ID_KEY] as string,
      managerId: (req as any)[MANAGER_ID_KEY] as string | undefined,
    });
  }
}
