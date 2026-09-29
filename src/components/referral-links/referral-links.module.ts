import { Module } from '@nestjs/common';
import { ManagersModule } from '../managers/managers.module';
import { UsersModule } from '../users/users.module';
import { ReferralLinksCabinetController } from './referral-links-cabinet.controller';
import { ReferralLinksController } from './referral-links.controller';
import { ReferralLinksPublicController } from './referral-links-public.controller';
import { ReferralLinksService } from './referral-links.service';
import { ReferralPinCodeGuard } from './guards/referral-pin-code.guard';

@Module({
  imports: [UsersModule, ManagersModule],
  controllers: [
    ReferralLinksController,
    ReferralLinksPublicController,
    ReferralLinksCabinetController,
  ],
  providers: [ReferralLinksService, ReferralPinCodeGuard],
  exports: [ReferralLinksService],
})
export class ReferralLinksModule {}
