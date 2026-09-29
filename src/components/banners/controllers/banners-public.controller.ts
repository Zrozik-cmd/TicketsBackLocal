import { Controller, Get, Query } from '@nestjs/common';
import { PublicBannersQueryDto } from '../dto/public-banners-query.dto';
import { BannersService } from '../services/banners.service';

@Controller('banners/public')
export class BannersPublicController {
  constructor(private readonly bannersService: BannersService) {}

  @Get()
  list(@Query() query: PublicBannersQueryDto) {
    return this.bannersService.findPublic(query.locale ?? 'en');
  }
}
