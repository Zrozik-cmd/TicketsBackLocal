import { Controller, Headers, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { LINE_WEBHOOK_PATH } from '../constants/event-messengers.constants';
import { LineIntegrationService } from '../services/line-integration.service';

/**
 * Public LINE webhook, one URL per integration. The body arrives as a Buffer (the
 * `express.raw` parser registered for this path in `main.ts`) and is read from the
 * request directly, so the global ValidationPipe never sees it and the signature is
 * checked against the exact bytes LINE signed.
 */
@Controller(LINE_WEBHOOK_PATH)
export class LineWebhookController {
  constructor(private readonly lineIntegration: LineIntegrationService) {}

  @Post(':webhookKey')
  @HttpCode(200)
  handle(
    @Param('webhookKey') webhookKey: string,
    @Headers('x-line-signature') signature: string | undefined,
    @Req() req: Request,
  ) {
    const rawBody = Buffer.isBuffer(req.body) ? (req.body as Buffer) : null;
    return this.lineIntegration.handleWebhook(webhookKey, rawBody, signature);
  }
}
