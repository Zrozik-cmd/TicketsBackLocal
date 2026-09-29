import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module';
import { EventSessionsModule } from '../event-sessions/event-sessions.module';
import { ManagersModule } from '../managers/managers.module';
import { PuppeteerModule } from '../../services/puppeteer/puppeteer.module';
import { TicketRegistryController } from './ticket-registry.controller';
import { TicketRegistryService } from './ticket-registry.service';
import { SessionOrdersService } from './session-orders.service';

@Module({
  imports: [EventsModule, EventSessionsModule, ManagersModule, PuppeteerModule],
  controllers: [TicketRegistryController],
  providers: [TicketRegistryService, SessionOrdersService],
  // Admin statistics mirrors (AdminModule) call the same services without ownership.
  exports: [TicketRegistryService, SessionOrdersService],
})
export class TicketRegistryModule {}
