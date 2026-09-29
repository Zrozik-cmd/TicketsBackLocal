import { Body, Controller, Headers, Post } from '@nestjs/common';
import { TelegramBotService } from '../services/telegram-bot.service';

@Controller('api/telegram')
export class TelegramWebhookController {
  constructor(private readonly telegramBotService: TelegramBotService) {}

  @Post('webhook')
  handleWebhook(
    @Headers('x-telegram-bot-api-secret-token') secretToken: string | undefined,
    @Body() update: Record<string, unknown>,
  ) {
    this.telegramBotService.assertWebhookSecret(secretToken);
    return this.telegramBotService.handleWebhookUpdate(update as any);
  }
}
