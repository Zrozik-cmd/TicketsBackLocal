import { Module } from '@nestjs/common';
import { AdminAuthTokensHelper } from '../admin/admin-auth-tokens.helper';
import { AdminGuard } from '../admin/guards/admin.guard';
import { EventsModule } from '../events/events.module';
import { ManagersModule } from '../managers/managers.module';
import { MediaModule } from '../media/media.module';
import { AdminFinanceController } from './controllers/admin-finance.controller';
import { OrganizerFinanceController } from './controllers/organizer-finance.controller';
import { FinanceAdminBoardService } from './services/finance-admin-board.service';
import { FinanceArbiPayBalanceService } from './services/finance-arbipay-balance.service';
import { FinanceBalancesService } from './services/finance-balances.service';
import { FinanceCashService } from './services/finance-cash.service';
import { FinanceDirectoryService } from './services/finance-directory.service';
import { FinanceOrganizerService } from './services/finance-organizer.service';
import { FinancePayoutsService } from './services/finance-payouts.service';
import { FinanceSalesService } from './services/finance-sales.service';

/**
 * Финансы Lotus: продажи, комиссии, наличные (FIFO-оценка по событиям),
 * сейф и выплаты организаторам. Локальные данные; единственный внешний запрос —
 * живой баланс ARBI Pay через платёжный микросервис (FinanceArbiPayBalanceService).
 *
 * AdminGuard и AdminAuthTokensHelper объявлены провайдерами здесь же — как в
 * CashEncashmentsModule, без импорта AdminModule (иначе циклический импорт).
 * Сервисы экспортируются для кабинета организатора.
 *
 * Кабинет организатора (OrganizerFinanceController): ManagersModule нужен
 * UserOrManagerGuard (ManagersService), EventsModule — остаток мест из статистики
 * организатора. Ни один из них не импортирует FinanceModule — цикла нет.
 */
@Module({
  imports: [MediaModule, ManagersModule, EventsModule],
  controllers: [AdminFinanceController, OrganizerFinanceController],
  providers: [
    FinanceDirectoryService,
    FinanceSalesService,
    FinanceCashService,
    FinanceBalancesService,
    FinancePayoutsService,
    FinanceAdminBoardService,
    FinanceArbiPayBalanceService,
    FinanceOrganizerService,
    AdminGuard,
    AdminAuthTokensHelper,
  ],
  exports: [
    FinanceDirectoryService,
    FinanceSalesService,
    FinanceCashService,
    FinanceBalancesService,
    FinancePayoutsService,
  ],
})
export class FinanceModule {}
