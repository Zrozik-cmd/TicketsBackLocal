import {
  Body,
  Controller,
  Get,
  HttpCode,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
  Param,
  ParseIntPipe,
} from "@nestjs/common";
import {
  ADMIN_ID_KEY,
  AdminGuard,
  type AdminAuthenticatedRequest,
} from "../guards/admin.guard";
import { AdminEventsService } from "../services/admin-events.service";
import { AdminEventSponsorsService } from "../services/admin-event-sponsors.service";
import { ArbiPayStoresService } from "../../arbipay-stores/arbipay-stores.service";
import { AdminEventsQueryDto } from "../dto/admin-events-query.dto";
import { RejectEventDto } from "../dto/reject-event.dto";
import { UpdateEventDescriptionDto } from "../dto/update-event-description.dto";
import { DeleteEventDto } from "../dto/delete-event.dto";
import { UpdateEventCashPaymentDto } from "../dto/update-event-cash-payment.dto";
import { UpdateEventSponsorsDto } from "../dto/update-event-sponsors.dto";

@Controller("admin/events")
@UseGuards(AdminGuard)
export class AdminEventsController {
  constructor(
    private readonly adminEventsService: AdminEventsService,
    private readonly adminEventSponsorsService: AdminEventSponsorsService,
    private readonly arbiPayStoresService: ArbiPayStoresService,
  ) {}

  @Get()
  getEvents(@Query() query: AdminEventsQueryDto) {
    return this.adminEventsService.getEvents(query);
  }

  @Get("moderation/count")
  getModerationEventsCount() {
    return this.adminEventsService.getModerationEventsCount();
  }

  /**
   * MODERATION → ACTIVE; applies pending sponsors and writes the approval snapshot.
   *
   * Publication is the only way an event becomes ACTIVE (events are created as DRAFT or
   * MODERATION), so this is where the event gets its own ARBI Pay store. Not awaited and
   * never failing the publication: `ensureStoreForEvent` logs its own errors and the
   * arbipay-stores cron finishes a store whose creation did not complete. Kept out of the
   * frozen AdminEventsService.
   */
  @Post(":id/confirm")
  async confirmEvent(
    @Req() req: AdminAuthenticatedRequest,
    @Param("id", ParseIntPipe) id: number,
  ) {
    const detail = await this.adminEventsService.confirmEvent(id, req[ADMIN_ID_KEY]);
    void this.arbiPayStoresService.ensureStoreForEvent(id);
    return detail;
  }

  /** Approves pending sponsors of an event outside MODERATION; returns the event detail. */
  @Post(":id/sponsors/approve")
  approveSponsors(
    @Req() req: AdminAuthenticatedRequest,
    @Param("id", ParseIntPipe) id: number,
  ) {
    return this.adminEventsService.approveSponsors(id, req[ADMIN_ID_KEY]);
  }

  /**
   * Saves the event's sponsors (the whole list) and the e-mail ticket format; returns the
   * event detail. The admin panel owns this block: the list goes onto the tickets at once.
   */
  @Put(":id/sponsors")
  @HttpCode(200)
  async updateSponsors(
    @Req() req: AdminAuthenticatedRequest,
    @Param("id", ParseIntPipe) id: number,
    @Body() body: UpdateEventSponsorsDto,
  ) {
    await this.adminEventSponsorsService.replaceSponsors(id, body, req[ADMIN_ID_KEY]);
    return this.adminEventsService.getEventById(id);
  }

  @Post(":id/reject")
  rejectEvent(
    @Param("id", ParseIntPipe) id: number,
    @Body() body: RejectEventDto,
  ) {
    return this.adminEventsService.rejectEvent(id, body.rejectReason);
  }

  @Patch(":id/description")
  updateEventDescription(
    @Param("id", ParseIntPipe) id: number,
    @Body() body: UpdateEventDescriptionDto,
  ) {
    return this.adminEventsService.updateEventDescription(id, body.description);
  }

  @Get(":id/deletion-check")
  getEventDeletionCheck(@Param("id", ParseIntPipe) id: number) {
    return this.adminEventsService.getDeletionCheck(id);
  }

  @Post(":id/delete")
  deleteEvent(
    @Req() req: AdminAuthenticatedRequest,
    @Param("id", ParseIntPipe) id: number,
    @Body() body: DeleteEventDto,
  ) {
    return this.adminEventsService.deleteEvent(
      id,
      body.confirmation,
      req[ADMIN_ID_KEY],
    );
  }

  @Get(":id/cash-payment")
  getEventCashPayment(@Param("id", ParseIntPipe) id: number) {
    return this.adminEventsService.getCashPaymentState(id);
  }

  @Patch(":id/cash-payment")
  updateEventCashPayment(
    @Req() req: AdminAuthenticatedRequest,
    @Param("id", ParseIntPipe) id: number,
    @Body() body: UpdateEventCashPaymentDto,
  ) {
    return this.adminEventsService.setCashPayment(
      id,
      body.enabled,
      req[ADMIN_ID_KEY],
    );
  }

  @Get(":id")
  getEventById(@Param("id", ParseIntPipe) id: number) {
    return this.adminEventsService.getEventById(id);
  }
}
