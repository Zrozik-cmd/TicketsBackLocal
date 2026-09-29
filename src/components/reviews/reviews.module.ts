import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { AdminAuthTokensHelper } from '../admin/admin-auth-tokens.helper';
import { CustomerAuthTokensHelper } from '../customers/customer-auth-tokens.helper';
import { MediaModule } from '../media/media.module';
import { EventMessengersModule } from '../event-messengers/event-messengers.module';
import { ReviewsAdminController } from './reviews-admin.controller';
import { ReviewsPublicController } from './reviews-public.controller';
import { ReviewsTelegramController } from './reviews-telegram.controller';
import { ReviewsTelegramUpdatesService } from './reviews-telegram-updates.service';
import { ReviewsTelegramService } from './reviews-telegram.service';
import { ReviewsService } from './reviews.service';

@Module({
  imports: [HttpModule.register({ timeout: 15000 }), MediaModule, EventMessengersModule],
  controllers: [
    ReviewsPublicController,
    ReviewsAdminController,
    ReviewsTelegramController,
  ],
  providers: [
    ReviewsService,
    ReviewsTelegramService,
    ReviewsTelegramUpdatesService,
    CustomerAuthTokensHelper,
    AdminAuthTokensHelper,
  ],
  exports: [ReviewsService],
})
export class ReviewsModule {}
