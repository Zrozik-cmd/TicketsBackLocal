import { Module } from '@nestjs/common';
import { TicketsService } from './tickets.service';
import { TicketsController } from './tickets.controller';
import { TicketSalesController } from './ticket-sales.controller';
import { CustomersModule } from '../customers/customers.module';
import { ManagersModule } from '../managers/managers.module';
import { ReferralLinksModule } from '../referral-links/referral-links.module';
import { EventsModule } from '../events/events.module';

@Module({
  imports: [CustomersModule, ReferralLinksModule, ManagersModule, EventsModule],
  controllers: [TicketsController, TicketSalesController],
  providers: [TicketsService],
  exports: [TicketsService],
})
export class TicketsModule {}
