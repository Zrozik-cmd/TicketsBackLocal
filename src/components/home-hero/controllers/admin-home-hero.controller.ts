import { Body, Controller, Get, Param, ParseIntPipe, Put, Req, UseGuards } from '@nestjs/common';
import { ADMIN_ID_KEY, AdminAuthenticatedRequest, AdminGuard } from '../../admin/guards/admin.guard';
import { SetHomeHeroDto } from '../dto/set-home-hero.dto';
import { HomeHeroService } from '../home-hero.service';

/** Секция «Главное событие» на странице события в админке. */
@Controller('admin/events/:id/home-hero')
@UseGuards(AdminGuard)
export class AdminHomeHeroController {
  constructor(private readonly homeHeroService: HomeHeroService) {}

  @Get()
  get(@Param('id', ParseIntPipe) id: number) {
    return this.homeHeroService.getState(id);
  }

  @Put()
  set(@Param('id', ParseIntPipe) id: number, @Body() dto: SetHomeHeroDto, @Req() req: AdminAuthenticatedRequest) {
    return this.homeHeroService.setFeatured(id, dto.featured, req[ADMIN_ID_KEY]);
  }
}
