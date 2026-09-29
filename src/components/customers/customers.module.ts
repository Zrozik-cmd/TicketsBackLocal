import { Module } from '@nestjs/common';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';
import { CustomerAuthTokensHelper } from './customer-auth-tokens.helper';
import { CustomersAuthService } from './customers-auth.service';
import { CustomerGuard } from './guards/customer.guard';
import { ReferralLinksService } from '../referral-links/referral-links.service';

@Module({
  controllers: [CustomersController],
  providers: [
    CustomersService,
    ReferralLinksService,
    CustomerAuthTokensHelper,
    CustomersAuthService,
    CustomerGuard,
  ],
  exports: [
    CustomersService,
    CustomersAuthService,
    CustomerAuthTokensHelper,
    CustomerGuard,
  ],
})
export class CustomersModule {}
