import { Module } from '@nestjs/common';
import { AdminGuard } from '../admin/guards/admin.guard';
import { AdminAuthTokensHelper } from '../admin/admin-auth-tokens.helper';
import { AdminCashiersController } from './controllers/admin-cashiers.controller';
import { CashierArbiAuthController } from './controllers/cashier-arbi-auth.controller';
import { CashierArbiAuthTokensHelper } from './cashier-arbi-auth-tokens.helper';
import { CashierArbiService } from './cashier-arbi.service';

@Module({
  controllers: [AdminCashiersController, CashierArbiAuthController],
  providers: [
    CashierArbiService,
    CashierArbiAuthTokensHelper,
    AdminGuard,
    AdminAuthTokensHelper,
  ],
  exports: [CashierArbiService, CashierArbiAuthTokensHelper],
})
export class CashierArbiModule {}
