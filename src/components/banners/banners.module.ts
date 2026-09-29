import { Module } from '@nestjs/common';
import { MediaModule } from '../media/media.module';
import { AdminModule } from '../admin/admin.module';
import { AdminBannersController } from './controllers/admin-banners.controller';
import { BannersPublicController } from './controllers/banners-public.controller';
import { BannersService } from './services/banners.service';

@Module({
  imports: [MediaModule, AdminModule],
  controllers: [AdminBannersController, BannersPublicController],
  providers: [BannersService],
  exports: [BannersService],
})
export class BannersModule {}
