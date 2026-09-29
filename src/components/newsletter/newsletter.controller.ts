import { Body, Controller, Logger, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { SubscribeNewsletterDto } from './dto/subscribe-newsletter.dto';
import { NewsletterService } from './services/newsletter.service';

@Controller('newsletter')
export class NewsletterController {
  private readonly logger = new Logger(NewsletterController.name);

  constructor(private readonly newsletterService: NewsletterService) {}

  @Post('subscribe')
  subscribe(@Req() req: Request, @Body() dto: SubscribeNewsletterDto) {
    // Both raw headers next to the resolved value, so the nginx proxy_set_header setup can be verified from logs.
    this.logger.log(
      `subscribe ip resolution: x-real-ip=${JSON.stringify(req.headers['x-real-ip'] ?? null)}, x-forwarded-for=${JSON.stringify(req.headers['x-forwarded-for'] ?? null)}, req.ip=${JSON.stringify(req.ip ?? null)}, resolved=${resolveClientIp(req)}`,
    );
    return this.newsletterService.subscribeFromFooter({
      email: dto.email,
      locale: dto.locale,
      website: dto.website,
      ip: resolveClientIp(req),
    });
  }
}

/**
 * X-Real-IP only: nginx overwrites it with the connection address, so a client
 * cannot spoof it. Without the header (nginx not configured / local dev) every
 * request shares the 'unknown' bucket, degrading the per-IP limit to a global one.
 */
function resolveClientIp(req: Request): string {
  const realIp = ((req.headers['x-real-ip'] ?? '') as string).trim();
  if (!realIp) return 'unknown';
  return realIp.toLowerCase().replace(/^::ffff:/, '');
}
