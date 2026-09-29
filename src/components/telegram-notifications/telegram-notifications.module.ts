import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { CustomersModule } from '../customers/customers.module';
import { EventsModule } from '../events/events.module';
import { ManagersModule } from '../managers/managers.module';
import { UsersModule } from '../users/users.module';
import { TelegramRecipientsController } from './controllers/telegram-recipients.controller';
import { TelegramWebhookController } from './controllers/telegram-webhook.controller';
import { TelegramApiService } from './services/telegram-api.service';
import { TelegramBotService } from './services/telegram-bot.service';
import { TelegramRecipientsService } from './services/telegram-recipients.service';
import { TelegramSalesNotificationService } from './services/telegram-sales-notification.service';

@Module({
  imports: [
    HttpModule.register({ timeout: 120_000, maxRedirects: 0 }),
    UsersModule,
    ManagersModule,
    EventsModule,
    CustomersModule,
  ],
  controllers: [TelegramRecipientsController, TelegramWebhookController],
  providers: [
    TelegramApiService,
    TelegramBotService,
    TelegramRecipientsService,
    TelegramSalesNotificationService,
  ],
  exports: [TelegramSalesNotificationService],
})
export class TelegramNotificationsModule {}
