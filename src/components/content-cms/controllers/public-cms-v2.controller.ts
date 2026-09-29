import { Controller, Get, Param } from '@nestjs/common';
import { CmsV2Service } from '../services/cms-v2.service';

@Controller('content')
export class PublicCmsV2Controller {
  constructor(private readonly cmsService: CmsV2Service) {}

  @Get(':slug')
  getPublishedPage(@Param('slug') slug: string) {
    return this.cmsService.getPublishedPageBySlug(slug);
  }
}
