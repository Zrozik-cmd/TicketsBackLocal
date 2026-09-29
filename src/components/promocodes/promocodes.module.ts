import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { EventsModule } from '../events/events.module';
import { ManagersModule } from '../managers/managers.module';
import { UsersModule } from '../users/users.module';
import { PromocodeTicketsController } from './promocode-tickets.controller';
import { PromocodesController } from './promocodes.controller';
import { PromocodesService } from './promocodes.service';

@Module({
  imports: [UsersModule, ManagersModule, EventsModule, CustomersModule],
  controllers: [PromocodesController, PromocodeTicketsController],
  providers: [PromocodesService],
  exports: [PromocodesService],
})
export class PromocodesModule {}
