import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { MediaModule } from '../media/media.module';
import { AdminCmsV2Controller } from './controllers/admin-cms-v2.controller';
import { PublicCmsV2Controller } from './controllers/public-cms-v2.controller';
import { CmsV2Service } from './services/cms-v2.service';

@Module({
  imports: [AdminModule, MediaModule],
  controllers: [AdminCmsV2Controller, PublicCmsV2Controller],
  providers: [CmsV2Service],
  exports: [CmsV2Service],
})
export class ContentCmsModule {}
