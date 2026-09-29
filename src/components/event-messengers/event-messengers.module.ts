import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { AdminAuthTokensHelper } from '../admin/admin-auth-tokens.helper';
import { LINE_API_TIMEOUT_MS } from './constants/event-messengers.constants';
import { AdminEventMessengersController } from './controllers/admin-event-messengers.controller';
import { LineWebhookController } from './controllers/line-webhook.controller';
import { LineApiClient } from './line/line-api.client';
import { EventMessengerDeliveriesService } from './services/event-messenger-deliveries.service';
import { EventMessengerDeliveryService } from './services/event-messenger-delivery.service';
import { EventMessengersNotifierService } from './services/event-messengers-notifier.service';
import { LineIntegrationService } from './services/line-integration.service';

/**
 * Per-event messenger (LINE group) notifications. A leaf module: it imports no feature
 * module, so EventsModule, MockOrdersModule, ReviewsModule and AdminModule can import it
 * to call `EventMessengersNotifierService` from their flows.
 */
@Module({
  imports: [HttpModule.register({ timeout: LINE_API_TIMEOUT_MS })],
  controllers: [AdminEventMessengersController, LineWebhookController],
  providers: [
    LineApiClient,
    EventMessengerDeliveryService,
    EventMessengerDeliveriesService,
    EventMessengersNotifierService,
    LineIntegrationService,
    AdminAuthTokensHelper,
  ],
  exports: [EventMessengersNotifierService],
})
export class EventMessengersModule {}
