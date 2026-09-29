import { Module } from '@nestjs/common';
import { MediaModule } from '../../components/media/media.module';
import { EventsModule } from '../../components/events/events.module';
import { TicketsModule } from '../../components/tickets/tickets.module';
import { CustomersModule } from '../../components/customers/customers.module';
import { PuppeteerBrowserService } from './puppeteer-browser.service';
import { TicketPuppeteerService } from './ticket-puppeteer.service';

@Module({
  imports: [MediaModule, EventsModule, TicketsModule, CustomersModule],
  providers: [PuppeteerBrowserService, TicketPuppeteerService],
  exports: [PuppeteerBrowserService, TicketPuppeteerService],
})
export class PuppeteerModule {}