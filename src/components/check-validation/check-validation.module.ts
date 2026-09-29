import { Module } from '@nestjs/common';
import { CheckValidationController } from './check-validation.controller';
import { CheckValidationService } from './check-validation.service';
import { MockOrdersModule } from '../mock-orders/mock-orders.module';
import { CustomersModule } from '../customers/customers.module';
import { ManagersModule } from '../managers/managers.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [MockOrdersModule, CustomersModule, UsersModule, ManagersModule],
  controllers: [CheckValidationController],
  providers: [CheckValidationService],
})
export class CheckValidationModule {}
