import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { MockOrdersController } from './mock-orders.controller';
import { MockSalesController } from './mock-sales.controller';
import { MockOrdersService } from './mock-orders.service';
import { PaymentMicroserviceService } from './payment/payment-microservice.service';
import { OmisePaymentService } from './payment/omise-payment.service';
import { EventsModule } from '../events/events.module';
import { EventSessionsModule } from '../event-sessions/event-sessions.module';
import { TicketsModule } from '../tickets/tickets.module';
import { CustomersModule } from '../customers/customers.module';
import { ReferralLinksModule } from '../referral-links/referral-links.module';
import { PromocodesModule } from '../promocodes/promocodes.module';
import { TelegramNotificationsModule } from '../telegram-notifications/telegram-notifications.module';
import { EventMessengersModule } from '../event-messengers/event-messengers.module';
// MAILCHIMP-DISABLED: newsletter not ready for prod — uncomment to re-enable
// import { NewsletterModule } from '../newsletter/newsletter.module';
import { ManagersModule } from '../managers/managers.module';
import { CashEncashmentsModule } from '../cash-encashments/cash-encashments.module';
import { ArbiPayStoresModule } from '../arbipay-stores/arbipay-stores.module';
import { PuppeteerModule } from '../../services/puppeteer/puppeteer.module';
import { CashOrdersController } from '../cash-orders/cash-orders.controller';
import { OrdersCashBookingController } from '../cash-orders/orders-cash-booking.controller';
import { CashOrdersService } from '../cash-orders/cash-orders.service';
import { CashOrdersAccessGuard } from '../cash-orders/guards/cash-orders-access.guard';
import { AdminAuthTokensHelper } from '../admin/admin-auth-tokens.helper';
import { CashierArbiAuthTokensHelper } from '../cashier-arbi/cashier-arbi-auth-tokens.helper';

@Module({
  imports: [
    HttpModule.register({ timeout: 30000, maxRedirects: 0 }),
    ManagersModule,
    PuppeteerModule,
    EventsModule,
    EventSessionsModule,
    TicketsModule,
    CustomersModule,
    ReferralLinksModule,
    PromocodesModule,
    TelegramNotificationsModule,
    EventMessengersModule,
    // MAILCHIMP-DISABLED: newsletter not ready for prod — uncomment to re-enable
    // NewsletterModule,
    CashEncashmentsModule,
    ArbiPayStoresModule,
  ],
  controllers: [
    MockOrdersController,
    MockSalesController,
    OrdersCashBookingController,
    CashOrdersController,
  ],
  providers: [
    MockOrdersService,
    PaymentMicroserviceService,
    OmisePaymentService,
    CashOrdersService,
    CashOrdersAccessGuard,
    AdminAuthTokensHelper,
    CashierArbiAuthTokensHelper,
  ],
  exports: [MockOrdersService],
})
export class MockOrdersModule {}
