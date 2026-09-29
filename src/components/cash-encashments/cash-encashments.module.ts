import { Module } from '@nestjs/common';
import { AdminGuard } from '../admin/guards/admin.guard';
import { AdminAuthTokensHelper } from '../admin/admin-auth-tokens.helper';
import { CashierArbiAuthTokensHelper } from '../cashier-arbi/cashier-arbi-auth-tokens.helper';
import { CashOrdersAccessGuard } from '../cash-orders/guards/cash-orders-access.guard';
import { AdminCashCollectorsController } from './controllers/admin-cash-collectors.controller';
import { AdminCashSettingsController } from './controllers/admin-cash-settings.controller';
import { CashStatsController } from './controllers/cash-stats.controller';
import { CashEncashmentsService } from './cash-encashments.service';

/**
 * Гварды и токен-хелперы объявлены заново, а не импортированы модулями-хозяевами —
 * тот же приём, что в CashierArbiModule: без него затягивается циклический импорт
 * через AdminModule.
 */
@Module({
  controllers: [CashStatsController, AdminCashCollectorsController, AdminCashSettingsController],
  providers: [
    CashEncashmentsService,
    CashOrdersAccessGuard,
    AdminGuard,
    AdminAuthTokensHelper,
    CashierArbiAuthTokensHelper,
  ],
  exports: [CashEncashmentsService],
})
export class CashEncashmentsModule {}
