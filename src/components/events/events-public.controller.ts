import { Controller, Get, Logger, Param, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { EventsService } from './events.service';

@Controller('events/public')
export class EventsPublicController {
  private readonly logger = new Logger(EventsPublicController.name);

  constructor(private readonly eventsService: EventsService) {}

  @Get()
  getList(
    @Req() req: Request,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    /** `top` = one-off events, `regular` = recurring ones. Omitted = both. */
    @Query('kind') kind?: string,
  ) {
    // TEMP DEBUG: verify nginx proxy_set_header forwarding (X-Real-IP / X-Forwarded-For). Remove once confirmed.
    this.logger.log(
      `client ip headers: x-real-ip=${JSON.stringify(req.headers['x-real-ip'] ?? null)}, x-forwarded-for=${JSON.stringify(req.headers['x-forwarded-for'] ?? null)}, req.ip=${JSON.stringify(req.ip ?? null)}`,
    );
    return this.eventsService.findPublic({ limit, offset, kind });
  }

  @Get('hero')
  getHeroEvent() {
    return this.eventsService.getHeroEvent();
  }

  /** Calendar feed for the purchase page of a regular event. */
  @Get(':eventId/sessions')
  getSessions(@Param('eventId') eventId: string) {
    return this.eventsService.getPublicSessions(Number(eventId));
  }

  @Get(':slug')
  getBySlug(@Param('slug') slug: string) {
    return this.eventsService.findOnePublicBySlug(slug);
  }
}
