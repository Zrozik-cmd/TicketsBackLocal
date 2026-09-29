import { Module } from "@nestjs/common";
import { DatabaseService } from "./services/DatabaseService/database.service";
import { InitService } from "./services/InitService/InitService";
import { ConfigModule } from '@nestjs/config';
import { EventsModule } from './components/events/events.module';
import { EventSessionsModule } from './components/event-sessions/event-sessions.module';
import { ReviewsModule } from './components/reviews/reviews.module';
import { FavoritesModule } from './components/favorites/favorites.module';
import { UsersModule } from './components/users/users.module';
import { CustomersModule } from './components/customers/customers.module';
import { ManagersModule } from './components/managers/managers.module';
import { MockOrdersModule } from './components/mock-orders/mock-orders.module';
import { TicketsModule } from './components/tickets/tickets.module';
import { TicketRegistryModule } from './components/ticket-registry/ticket-registry.module';
import { MediaModule } from './components/media/media.module';
import { CheckValidationModule } from './components/check-validation/check-validation.module';
import { RedisModule } from './services/redis/redis.module';
import { NotificationModule } from './services/NotificationService/notification.module';
import { ReferralLinksModule } from './components/referral-links/referral-links.module';
import { PromocodesModule } from './components/promocodes/promocodes.module';
import { AdminModule } from './components/admin/admin.module';
import { BannersModule } from './components/banners/banners.module';
import { SupportMessagesModule } from './components/support-messages/support-messages.module';
import { TelegramNotificationsModule } from './components/telegram-notifications/telegram-notifications.module';
import { CashierArbiModule } from './components/cashier-arbi/cashier-arbi.module';
import { CashEncashmentsModule } from './components/cash-encashments/cash-encashments.module';
import { ContentCmsModule } from './components/content-cms/content-cms.module';
import { EventMessengersModule } from './components/event-messengers/event-messengers.module';
import { FinanceModule } from './components/finance/finance.module';
import { HomeHeroModule } from './components/home-hero/home-hero.module';
import { SeatingPlanModule } from './components/seating-plan/seating-plan.module';
// MAILCHIMP-DISABLED: newsletter not ready for prod — uncomment to re-enable
// import { NewsletterModule } from './components/newsletter/newsletter.module';
import { ScheduleModule } from '@nestjs/schedule';
import * as path from 'path';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Сначала .env в папке бэкенда, затем корень проекта (общий .env)
      envFilePath: [path.join(process.cwd(), '.env'), path.join(process.cwd(), '..', '.env')],
    }),
    ScheduleModule.forRoot(),
    RedisModule,
    NotificationModule,
    EventsModule,
    EventSessionsModule,
    ReviewsModule,
    FavoritesModule,
    UsersModule,
    CustomersModule,
    ManagersModule,
    TicketsModule,
    TicketRegistryModule,
    MockOrdersModule,
    MediaModule,
    CheckValidationModule,
    ReferralLinksModule,
    PromocodesModule,
    BannersModule,
    AdminModule,
    CashierArbiModule,
    CashEncashmentsModule,
    ContentCmsModule,
    FinanceModule,
    HomeHeroModule,
    SeatingPlanModule,
    // MAILCHIMP-DISABLED: newsletter not ready for prod — uncomment to re-enable
    // NewsletterModule,
    SupportMessagesModule,
    TelegramNotificationsModule,
    EventMessengersModule,
  ],
  controllers: [], 
  providers: [
    InitService,
    DatabaseService
  ],
  exports: [DatabaseService],
})
export class AppModule {}
