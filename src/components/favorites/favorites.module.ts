import { Module } from '@nestjs/common';
import { CustomerAuthTokensHelper } from '../customers/customer-auth-tokens.helper';
import { EventsModule } from '../events/events.module';
import { FavoritesController } from './favorites.controller';
import { FavoritesService } from './favorites.service';

@Module({
  imports: [EventsModule],
  controllers: [FavoritesController],
  providers: [FavoritesService, CustomerAuthTokensHelper],
  exports: [FavoritesService],
})
export class FavoritesModule {}
