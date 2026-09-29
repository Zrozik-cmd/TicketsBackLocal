import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ADMIN_ID_KEY,
  AdminGuard,
  type AdminAuthenticatedRequest,
} from '../../admin/guards/admin.guard';
import { RetryLineDeliveriesDto } from '../dto/retry-line-deliveries.dto';
import { UpdateLineIntegrationDto } from '../dto/update-line-integration.dto';
import { EventMessengerDeliveriesService } from '../services/event-messenger-deliveries.service';
import { LineIntegrationService } from '../services/line-integration.service';

/** Messenger notifications of one event (LINE today). Admin panel only. */
@Controller('admin/events')
@UseGuards(AdminGuard)
export class AdminEventMessengersController {
  constructor(
    private readonly lineIntegration: LineIntegrationService,
    private readonly deliveries: EventMessengerDeliveriesService,
  ) {}

  @Get(':id/messengers')
  getMessengers(@Param('id', ParseIntPipe) id: number, @Req() req: AdminAuthenticatedRequest) {
    return this.lineIntegration.getMessengers(id, req);
  }

  /** Create or update; credentials are validated against LINE before anything is saved. */
  @Put(':id/messengers/line')
  saveLine(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: UpdateLineIntegrationDto,
    @Req() req: AdminAuthenticatedRequest,
  ) {
    return this.lineIntegration.saveLine(id, body, req[ADMIN_ID_KEY], req);
  }

  @Delete(':id/messengers/line')
  deleteLine(@Param('id', ParseIntPipe) id: number) {
    return this.lineIntegration.deleteLine(id);
  }

  @Post(':id/messengers/line/test')
  sendTest(@Param('id', ParseIntPipe) id: number) {
    return this.lineIntegration.sendTest(id);
  }

  /** One page, newest first: `limit` defaults to 20 and is clamped to 1…100, `offset` to 0. */
  @Get(':id/messengers/line/deliveries')
  listDeliveries(
    @Param('id', ParseIntPipe) id: number,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.deliveries.list(id, limit, offset);
  }

  /** Re-sends the failed messages of this event: the newest `limit` (10/20/50) or all. */
  @Post(':id/messengers/line/deliveries/retry')
  retryDeliveries(@Param('id', ParseIntPipe) id: number, @Body() body: RetryLineDeliveriesDto) {
    return this.deliveries.retryFailed(id, body.limit ?? null);
  }
}
