import { MediaModule } from '../media/media.module';
import { Logger, Module, OnApplicationBootstrap } from "@nestjs/common";
import mongoose from "mongoose";
import { AdminController } from "./controllers/admin-auth.controller";
import { AdminCustomersController } from "./controllers/admin-customers.controller";
import { AdminCustomersService } from "./services/admin-customers.service";
import { AdminEventStatisticsController } from "./controllers/admin-event-statistics.controller";
import { AdminEventsController } from "./controllers/admin-events.controller";
import { AdminEventsService } from "./services/admin-events.service";
import { AdminEventSponsorsService } from "./services/admin-event-sponsors.service";
import { AdminUsersController } from "./controllers/admin-users.controller";
import { AdminUsersService } from "./services/admin-users.service";
import { AdminFeesController } from "./controllers/admin-fees.controller";
import { AdminFeesService } from "./services/admin-fees.service";
import { AdminsService } from "./services/admins.service";
import { EventsModule } from "../events/events.module";
import { EventMessengersModule } from "../event-messengers/event-messengers.module";
import { MockOrdersModule } from "../mock-orders/mock-orders.module";
import { TicketRegistryModule } from "../ticket-registry/ticket-registry.module";
import { UsersModule } from "../users/users.module";
import { CashierArbiModule } from "../cashier-arbi/cashier-arbi.module";
import { CashEncashmentsModule } from "../cash-encashments/cash-encashments.module";
import { ManagersModule } from "../managers/managers.module";
import { AdminAuthTokensHelper } from "./admin-auth-tokens.helper";
import { AdminsAuthService } from "./services/admins-auth.service";
import { AdminGuard } from "./guards/admin.guard";
import { AdminOrCashierArbiGuard } from "./guards/admin-or-cashier-arbi.guard";
import { AdminMockOrdersController } from "@/components/admin/controllers/admin-mock-orders.controller";
import { AdminMockOrdersService } from "@/components/admin/services/admin-mock-orders.service";
import { ReferralLinksModule } from "../referral-links/referral-links.module";
import { PromocodesModule } from "../promocodes/promocodes.module";
import { AdminVaultController } from "./controllers/admin-vault.controller";
import { AdminVaultEventsService } from "./services/admin-vault-events.service";
import { AdminVaultTicketsService } from "./services/admin-vault-tickets.service";
import { AdminTicketRemovalService } from "./services/admin-ticket-removal.service";
import { ArbiPayStoresModule } from "../arbipay-stores/arbipay-stores.module";
import { AdminArbiPayStoresController } from "../arbipay-stores/admin-arbipay-stores.controller";

@Module({
  imports: [EventsModule, MockOrdersModule, UsersModule, CashierArbiModule, ManagersModule, CashEncashmentsModule, MediaModule, TicketRegistryModule, ReferralLinksModule, PromocodesModule, EventMessengersModule, ArbiPayStoresModule],
  controllers: [
    AdminController,
    AdminEventsController,
    AdminEventStatisticsController,
    AdminCustomersController,
    AdminUsersController,
    AdminFeesController,
    AdminMockOrdersController,
    AdminVaultController,
    AdminArbiPayStoresController,
  ],
  providers: [
    AdminsService,
    AdminAuthTokensHelper,
    AdminsAuthService,
    AdminGuard,
    AdminOrCashierArbiGuard,
    AdminEventsService,
    AdminEventSponsorsService,
    AdminCustomersService,
    AdminUsersService,
    AdminFeesService,
    AdminMockOrdersService,
    AdminVaultEventsService,
    AdminVaultTicketsService,
    AdminTicketRemovalService,
  ],
  exports: [
    AdminsService,
    AdminsAuthService,
    AdminAuthTokensHelper,
    AdminGuard,
  ],
})
export class AdminModule implements OnApplicationBootstrap {
  private readonly logger = new Logger(AdminModule.name);

  constructor(private readonly adminsService: AdminsService) {}

  /**
   * Creates the admin named by ADMIN_BOOTSTRAP_EMAIL / _PASSWORD when it is missing.
   *
   * `onApplicationBootstrap`, not `onModuleInit`: Nest initialises imported modules before the
   * root module's own providers, so at `onModuleInit` time `DatabaseService` has not called
   * `mongoose.connect` yet and this first query would buffer until mongoose's 10s timeout —
   * which killed the whole boot. Waits for the connection and swallows failures
   * (invariant J): a backend that cannot seed an admin must still come up.
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      await mongoose.connection.asPromise();
      await this.adminsService.bootstrapFromEnvIfNeeded();
    } catch (error) {
      this.logger.error(
        `Bootstrap admin was not created: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
